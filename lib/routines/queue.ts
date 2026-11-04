import "server-only";

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { fromDrizzle, PgBoss } from "pg-boss";
import { z } from "zod";

import { requireDatabaseUrl } from "../config/server";

export const ROUTINE_QUEUE = "routine.run";
export const ROUTINE_RETRY = {
  retryLimit: 2,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 300,
  expireInSeconds: 1200,
} as const;

const base = {
  ownerId: z.string().uuid(),
  routineId: z.string().uuid(),
  agentId: z.string().uuid(),
  executionId: z.string().uuid(),
  // TASK-042. A manual retry of a finished run points the new attempt at that run.
  retryOf: z.string().uuid().optional(),
};

export const routineJobSchema = z.discriminatedUnion("trigger", [
  z.object({ ...base, trigger: z.literal("schedule"), scheduledAt: z.string().datetime({ offset: true }) }).strict(),
  z.object({ ...base, trigger: z.literal("run_now") }).strict(),
]);
export type RoutineJob = z.infer<typeof routineJobSchema>;

export type PgBossTransaction = Parameters<typeof fromDrizzle>[0];
export interface RoutineJobState {
  state: "created" | "retry" | "active" | "completed" | "cancelled" | "failed";
  retryCount: number;
}

let queue: Promise<PgBoss> | undefined;
let stopping: PgBoss | undefined;

export function manualRoutineExecutionId(): string {
  return randomUUID();
}

export function routineGroup(agentId: string): { id: string } {
  return { id: agentId };
}

export function routineSingletonKey(executionId: string): string {
  return executionId;
}

export async function getRoutineQueue(): Promise<PgBoss> {
  queue ??= (async () => {
    const boss = new PgBoss({
      connectionString: requireDatabaseUrl("DATABASE_URL", process.env.DATABASE_URL),
      schema: "pgboss",
      migrate: false,
      schedule: false,
      reindex: false,
      max: 4,
      application_name: "eclipse-crew-routine",
    });
    boss.on("error", (error) => {
      let detail = "unknown";
      try {
        detail = error instanceof Error ? error.message
          : typeof error === "string" ? error
            : JSON.stringify(error).slice(0, 300);
      } catch { /* keep the fixed fallback */ }
      console.error("Routine queue error.", detail);
    });
    try {
      await boss.start({ attempts: 5 });
      await boss.createQueue(ROUTINE_QUEUE, {
        policy: "standard",
        ...ROUTINE_RETRY,
        deleteAfterSeconds: 86_400,
      });
      return boss;
    } catch {
      await boss.stop({ graceful: false }).catch(() => undefined);
      throw new Error("Routine queue startup failed.");
    }
  })().catch((error) => {
    queue = undefined;
    throw error;
  });
  return queue;
}

export async function enqueueRoutineJob(db: PgBossTransaction, input: RoutineJob): Promise<boolean> {
  const job = routineJobSchema.parse(input);
  const boss = await getRoutineQueue();
  const adapter = fromDrizzle(db, sql);
  const existing = await boss.findJobs(ROUTINE_QUEUE, { id: job.executionId, db: adapter, limit: 1 });
  if (existing.length) return false;
  const id = await boss.send(ROUTINE_QUEUE, job, {
    id: job.executionId,
    singletonKey: routineSingletonKey(job.executionId),
    group: routineGroup(job.agentId),
    ...ROUTINE_RETRY,
    db: adapter,
  });
  return id !== null;
}

export async function routineJobState(
  executionId: string,
  expected: { ownerId: string; routineId: string },
): Promise<RoutineJobState | null> {
  const boss = await getRoutineQueue();
  const [job] = await boss.findJobs<unknown>(ROUTINE_QUEUE, { id: executionId, limit: 1 });
  if (!job) return null;
  const payload = routineJobSchema.safeParse(job.data);
  if (!payload.success || payload.data.ownerId !== expected.ownerId || payload.data.routineId !== expected.routineId) return null;
  return { state: job.state, retryCount: job.retryCount };
}

export async function stopRoutineQueue(): Promise<void> {
  const active = await queue?.catch(() => undefined);
  if (!active || stopping === active) return;
  stopping = active;
  queue = undefined;
  await active.stop({ graceful: true, timeout: 30_000 });
}
