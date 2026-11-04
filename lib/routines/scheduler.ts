import "server-only";

import { and, asc, eq, lte } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { agents, owner, routines } from "../../db/schema";
import { enqueueMemoryTidy, startMemoryWorkers } from "../memory/queue";
import { startGithubDeviceWorkers } from "../connections/device-queue";
import { docKeyFor } from "../memory/schema";
import { getDatabase as connectDatabase } from "../../db/client";
import {
  routineCatchUpSchema,
  routineRecordSchema,
  routineScheduleSpecSchema,
  type RoutineRecord,
} from "./schema";
import { scheduledRoutineJobs } from "./execution-plan";
import { enqueueRoutineJob, getRoutineQueue, ROUTINE_QUEUE, routineJobSchema, type PgBossTransaction, type RoutineJob } from "./queue";
import { runRoutineExecution } from "./run";

type Database = Awaited<ReturnType<typeof getDatabase>>;
const TICK_MS = 60_000;
const RETENTION_SWEEP_MS = 20 * 60 * 60 * 1000;
let lastRetentionSweep = 0;
let retentionRunning = false;

// Evidence retention: heavy bytes older than 32 days thin out (receipts stay forever). Throttled to about once a day;
// if the meter reads full, a 7-day pass clears room first. It walks the whole blob store, so it runs beside the minute
// tick (one at a time) instead of inside it, and a long walk never delays routines.
function startRetentionSweep(database: Database): void {
  const now = Date.now();
  if (retentionRunning || now - lastRetentionSweep < RETENTION_SWEEP_MS) return;
  lastRetentionSweep = now;
  retentionRunning = true;
  void (async () => {
    const { sweepOldEvidence, EVIDENCE_RETENTION_DAYS } = await import("../retention/sweep");
    const { measureArtifacts } = await import("../retention/usage");
    const usage = await measureArtifacts().catch(() => null);
    if (usage && usage.fraction >= 1) await sweepOldEvidence(database, new Date(now), 7);
    await sweepOldEvidence(database, new Date(now), EVIDENCE_RETENTION_DAYS);
  })()
    .catch(() => console.error("Retention sweep failed."))
    .finally(() => { retentionRunning = false; });
}
const MAX_DUE_ROUTINES = 25;
const MAX_JOBS_PER_TICK = 200;
const MAX_JOBS_PER_ROUTINE = 100;
const SCHEDULER_KEY = Symbol.for("eclipse-crew.routine-scheduler");

export interface SchedulerHandle {
  stop(): Promise<void>;
}

let starting: Promise<SchedulerHandle> | undefined;

export async function tickRoutines(
  database: Database,
  enqueue: (db: PgBossTransaction, job: RoutineJob) => Promise<boolean>,
  now = new Date(),
): Promise<{ routines: number; jobs: number }> {
  const owners = await database.select({ id: owner.id, crewStoppedAt: owner.crewStoppedAt }).from(owner).limit(2);
  let processedRoutines = 0;
  let queuedJobs = 0;
  let remaining = MAX_JOBS_PER_TICK;

  for (const current of owners) {
    // TASK-052. A stopped crew schedules nothing; next_run_at stays as it was, so the catch-up policy applies on resume.
    if (current.crewStoppedAt) continue;
    const due = await database.select({ id: routines.id }).from(routines).where(and(
      eq(routines.ownerId, current.id),
      eq(routines.active, true),
      lte(routines.nextRunAt, now),
    )).orderBy(asc(routines.nextRunAt)).limit(MAX_DUE_ROUTINES);

    for (const candidate of due) {
      if (remaining <= 0) break;
      try {
        const count = await database.transaction(async (tx) => {
          const [row] = await tx.select().from(routines).where(and(
            eq(routines.ownerId, current.id),
            eq(routines.id, candidate.id),
            eq(routines.active, true),
            lte(routines.nextRunAt, now),
          )).limit(1).for("update", { skipLocked: true });
          if (!row) return 0;

          const spec = routineScheduleSpecSchema.safeParse(row.scheduleSpec);
          const catchUp = routineCatchUpSchema.safeParse(row.catchUp);
          if (!spec.success || !catchUp.success) return 0;

          const plan = scheduledRoutineJobs({
            ownerId: row.ownerId,
            routineId: row.id,
            agentId: row.agentId,
            spec: spec.data,
            timezone: row.timezone,
            nextRunAt: row.nextRunAt,
            now,
            catchUp: catchUp.data,
            limit: Math.min(MAX_JOBS_PER_ROUTINE, remaining),
          });
          if (remaining <= 0 && plan.jobs.length === 0) return 0;
          for (const job of plan.jobs) await enqueue(tx, job);
          await tx.update(routines).set({
            nextRunAt: plan.nextRunAt,
            active: plan.active,
            updatedAt: now,
          }).where(and(eq(routines.ownerId, current.id), eq(routines.id, row.id)));
          return plan.jobs.length;
        });
        if (count > 0) processedRoutines += 1;
        queuedJobs += count;
        remaining -= count;
      } catch {
        console.error("Routine tick skipped one routine.");
      }
    }
  }
  return { routines: processedRoutines, jobs: queuedJobs };
}

// TASK-086. At 03:00 in the owner's timezone, queue one tidy per document. The job id is fixed per local day, so a
// repeated tick never duplicates it; the worker also enforces at most one tidy per 6 hours per document.
export async function tickMemoryTidy(database: Database, now = new Date(), enqueue: typeof enqueueMemoryTidy = enqueueMemoryTidy): Promise<number> {
  const owners = await database.select({ id: owner.id, timezone: owner.timezone, crewStoppedAt: owner.crewStoppedAt }).from(owner).limit(2);
  let queued = 0;
  for (const current of owners) {
    if (current.crewStoppedAt) continue;
    let parts: Intl.DateTimeFormatPart[];
    try {
      parts = new Intl.DateTimeFormat("en-CA", { timeZone: current.timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" }).formatToParts(now);
    } catch { continue; }
    if (parts.find((part) => part.type === "hour")?.value !== "03") continue;
    const day = parts.filter((part) => ["year", "month", "day"].includes(part.type)).map((part) => part.value).join("-");
    const agentRows = await database.select({ id: agents.id }).from(agents).where(eq(agents.ownerId, current.id));
    try {
      for (const agent of agentRows) {
        for (const doc of ["memory", "private"] as const) {
          if (await enqueue({ ownerId: current.id, agentId: agent.id, doc, docKey: docKeyFor(doc, agent.id) },
            { id: `memory-tidy:${agent.id}:${doc}:${day}` })) queued += 1;
        }
      }
      if (agentRows[0] && await enqueue({ ownerId: current.id, agentId: agentRows[0].id, doc: "user", docKey: "user" },
        { id: `memory-tidy:${current.id}:user:${day}` })) queued += 1;
    } catch { console.error("Memory tidy tick skipped one owner."); }
  }
  return queued;
}

async function readRoutine(database: Database, job: RoutineJob): Promise<RoutineRecord | null> {
  const [row] = await database.select().from(routines).where(and(
    eq(routines.ownerId, job.ownerId),
    eq(routines.id, job.routineId),
    eq(routines.agentId, job.agentId),
  )).limit(1);
  if (!row) return null;
  const parsed = routineRecordSchema.safeParse({
    id: row.id,
    agentId: row.agentId,
    sourceMessageId: row.sourceMessageId,
    skillId: row.skillId,
    goal: row.goal,
    steps: row.steps,
    schedule: row.schedule,
    scheduleSpec: row.scheduleSpec,
    timezone: row.timezone,
    nextRunAt: row.nextRunAt.toISOString(),
    tools: row.tools,
    budgetCents: row.budgetCents,
    catchUp: row.catchUp,
    active: row.active,
    mode: "cron",
    createdAt: row.createdAt.toISOString(),
  });
  return parsed.success ? parsed.data : null;
}

export async function startRoutineScheduler(): Promise<SchedulerHandle> {
  const existing = (globalThis as Record<symbol, unknown>)[SCHEDULER_KEY] as SchedulerHandle | undefined;
  if (existing) return existing;
  starting ??= (async () => {
    const boss = await getRoutineQueue();
    const database = await connectDatabase();
    await boss.work(ROUTINE_QUEUE, {
      batchSize: 1,
      localConcurrency: 4,
      groupConcurrency: 1,
      pollingIntervalSeconds: 2,
    }, async ([job]) => {
      const parsed = routineJobSchema.safeParse(job.data);
      if (!parsed.success) return;
      const routine = await readRoutine(database, parsed.data);
      if (!routine) return;
      const result = await runRoutineExecution(database, parsed.data, routine, job.retryCount);
      if (result.retry) throw new Error("routine_retry");
    });

    await startMemoryWorkers(boss, database);
    await startGithubDeviceWorkers(boss, database);

    let currentTick: Promise<unknown> | undefined;
    const runTick = () => {
      if (currentTick) return currentTick;
      currentTick = tickRoutines(database, enqueueRoutineJob)
        .catch(() => console.error("Routine scheduler tick failed."))
        .then(() => tickMemoryTidy(database))
        .catch(() => console.error("Memory tidy tick failed."))
        .then(async () => {
          const { expireStaleFlows, refreshDueConnections } = await import("../connections/github-device");
          await expireStaleFlows(database);
          await refreshDueConnections(database);
        })
        .catch(() => console.error("GitHub device tick failed."))
        .then(async () => {
          if (process.env.RUN_SWEEPER_ENABLED === "false") return;
          const { loadReceiptSigner } = await import("../receipts/signer");
          const { sweepStalledRuns } = await import("../runs/sweeper");
          await sweepStalledRuns(database, loadReceiptSigner());
        })
        .catch(() => console.error("Run sweeper tick failed."))
        .then(() => { startRetentionSweep(database); })
        .finally(() => { currentTick = undefined; });
      return currentTick;
    };
    await runTick();
    const timer = setInterval(() => { void runTick(); }, TICK_MS);
    timer.unref?.();

    const handle: SchedulerHandle = {
      async stop() {
        clearInterval(timer);
        await currentTick?.catch(() => undefined);
        const { stopRoutineQueue } = await import("./queue");
        await stopRoutineQueue();
      },
    };
    (globalThis as Record<symbol, unknown>)[SCHEDULER_KEY] = handle;
    return handle;
  })().catch((error) => {
    starting = undefined;
    throw error;
  });
  return starting;
}
