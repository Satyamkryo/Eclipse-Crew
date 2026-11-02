import "server-only";

import { and, asc, eq, lte } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { owner, routines } from "../../db/schema";
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

    let currentTick: Promise<unknown> | undefined;
    const runTick = () => {
      if (currentTick) return currentTick;
      currentTick = tickRoutines(database, enqueueRoutineJob)
        .catch(() => console.error("Routine scheduler tick failed."))
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
