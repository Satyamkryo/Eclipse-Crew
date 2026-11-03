import "server-only";

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";
import { z } from "zod";

import { getRoutineQueue } from "../routines/queue";

export const CREW_REPORT_QUEUE = "crew.report";
export const CREW_REPORT_RETRY = {
  retryLimit: 3,
  retryDelay: 60,
  retryBackoff: true,
  retryDelayMax: 300,
  expireInSeconds: 300,
} as const;

export const crewReportJobSchema = z.object({
  ownerId: z.string().uuid(),
  scheduledAt: z.string().datetime({ offset: true }),
  timezone: z.string().min(1).max(100),
}).strict();
export type CrewReportJob = z.infer<typeof crewReportJobSchema>;

let ensured: Promise<void> | undefined;

export async function ensureCrewReportQueue(boss: PgBoss): Promise<void> {
  ensured ??= boss.createQueue(CREW_REPORT_QUEUE, {
    policy: "standard",
    ...CREW_REPORT_RETRY,
    deleteAfterSeconds: 86_400,
  }).then(() => undefined, (error) => { ensured = undefined; throw error; });
  return ensured;
}

// pg-boss job ids are UUID columns. A SHA-256 of the owner and exact occurrence is stable across ticks and processes.
export function crewReportJobId(ownerId: string, scheduledAt: Date): string {
  const hex = createHash("sha256").update(`crew-report:${ownerId}:${scheduledAt.toISOString()}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function crewReportJobKey(ownerId: string, scheduledAt: Date): string {
  return `crew-report:${ownerId}:${scheduledAt.toISOString()}`;
}

// A transaction from the tick or the plain database handle both satisfy pg-boss's drizzle adapter.
type QueueExecutor = Parameters<typeof fromDrizzle>[0];

// One job per owner occurrence. The fixed id is the first guard; the delivery row's unique key is the second.
export async function enqueueCrewReport(
  db: QueueExecutor, input: { ownerId: string; scheduledAt: Date; timezone: string },
): Promise<boolean> {
  const job = crewReportJobSchema.parse({
    ownerId: input.ownerId,
    scheduledAt: input.scheduledAt.toISOString(),
    timezone: input.timezone,
  });
  const boss = await getRoutineQueue();
  await ensureCrewReportQueue(boss);
  const scheduledAt = new Date(job.scheduledAt);
  const id = crewReportJobId(job.ownerId, scheduledAt);
  const adapter = fromDrizzle(db, sql);
  const existing = await boss.findJobs(CREW_REPORT_QUEUE, { id, db: adapter, limit: 1 });
  if (existing.length) return false;
  const sent = await boss.send(CREW_REPORT_QUEUE, job, {
    id,
    singletonKey: crewReportJobKey(job.ownerId, scheduledAt),
    ...CREW_REPORT_RETRY,
    db: adapter,
  });
  return sent !== null;
}
