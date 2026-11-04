import "server-only";

import { createHash } from "node:crypto";
import { fromDrizzle, type PgBoss } from "pg-boss";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { getDatabase } from "../../db/client";
import { getRoutineQueue } from "../routines/queue";
import { MEMORY_DOCUMENTS, type MemoryDocument } from "./schema";

type Database = Awaited<ReturnType<typeof getDatabase>>;

// TASK-086. Two queues on the existing pg-boss instance. Review runs once per agent after chat activity; tidy runs
// per document at 03:00 local, or at once when a document passes 85% of its cap. Both are idempotent by singleton key.
export const MEMORY_REVIEW_QUEUE = "memory.review";
export const MEMORY_TIDY_QUEUE = "memory.tidy";
const RETRY = { retryLimit: 1, retryDelay: 30, retryBackoff: false, expireInSeconds: 300 } as const;
export const REVIEW_DELAY_SECONDS = 120;
export const TIDY_AT_PERCENT = 0.85;

// Pure so the timing and idempotency contract can be checked without a live queue.
export function reviewSendOptions(agentId: string, delaySeconds = REVIEW_DELAY_SECONDS) {
  return { singletonKey: agentId, startAfter: delaySeconds, ...RETRY };
}

export function tidySendOptions(job: MemoryTidyJob, options: { id?: string; delaySeconds?: number } = {}) {
  // The scheduler supplies a readable per-day idempotency key; pg-boss IDs
  // are PostgreSQL UUIDs. Preserve the key's identity in a stable UUIDv8.
  const digest = options.id ? createHash("sha256").update(JSON.stringify([job.ownerId, job.docKey, options.id])).digest() : null;
  if (digest) { digest[6] = (digest[6] & 0x0f) | 0x80; digest[8] = (digest[8] & 0x3f) | 0x80; }
  const hex = digest?.subarray(0, 16).toString("hex");
  const id = hex ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : undefined;
  return {
    ...(id ? { id } : {}),
    singletonKey: `${job.agentId}:${job.docKey}`,
    startAfter: options.delaySeconds ?? 0,
    ...RETRY,
  };
}

// A write that leaves a document at 85% of its cap tidies it now instead of at 03:00.
export function needsTidy(chars: number, cap: number): boolean {
  return cap > 0 && chars >= cap * TIDY_AT_PERCENT;
}

export const memoryReviewJobSchema = z.object({
  ownerId: z.string().uuid(), agentId: z.string().uuid(), runId: z.string().uuid().optional(),
}).strict();

export const memoryTidyJobSchema = z.object({
  ownerId: z.string().uuid(), agentId: z.string().uuid(),
  doc: z.enum(MEMORY_DOCUMENTS), docKey: z.string().min(1).max(120),
}).strict();

export type MemoryReviewJob = z.infer<typeof memoryReviewJobSchema>;
export type MemoryTidyJob = z.infer<typeof memoryTidyJobSchema>;

let ready: Promise<PgBoss> | undefined;
export async function getMemoryQueue(): Promise<PgBoss> {
  ready ??= (async () => {
    const boss = await getRoutineQueue();
    await boss.createQueue(MEMORY_REVIEW_QUEUE, { policy: "standard", deleteAfterSeconds: 86_400 });
    await boss.createQueue(MEMORY_TIDY_QUEUE, { policy: "standard", deleteAfterSeconds: 86_400 });
    return boss;
  })().catch((error) => { ready = undefined; throw error; });
  return ready;
}

// Enqueued when a chat run ends. It starts after 120 s and only one review per agent is pending.
export async function enqueueMemoryReview(ownerId: string, agentId: string, runId?: string, delaySeconds = 120): Promise<boolean> {
  const job = memoryReviewJobSchema.parse({ ownerId, agentId, ...(runId ? { runId } : {}) });
  return enqueuePending(MEMORY_REVIEW_QUEUE, job, reviewSendOptions(agentId, delaySeconds));
}

// `id` makes a nightly run idempotent per agent, document and local day.
export async function enqueueMemoryTidy(job: MemoryTidyJob, options: { id?: string; delaySeconds?: number } = {}): Promise<boolean> {
  const parsed = memoryTidyJobSchema.parse(job);
  return enqueuePending(MEMORY_TIDY_QUEUE, parsed, tidySendOptions(parsed, options));
}

// A standard pg-boss queue does not deduplicate singletonKey by itself. Keep
// existing queues compatible and serialize the pending check and insert across
// app processes, using the same transaction for both pg-boss operations.
async function enqueuePending(
  name: string,
  job: MemoryReviewJob | MemoryTidyJob,
  options: ReturnType<typeof reviewSendOptions> | ReturnType<typeof tidySendOptions>,
): Promise<boolean> {
  const boss = await getMemoryQueue();
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${job.ownerId}), hashtext(${`${name}:${options.singletonKey}`}))`);
    const db = fromDrizzle(transaction, sql);
    const pending = await boss.findJobs(name, { key: options.singletonKey, data: { ownerId: job.ownerId }, queued: true, limit: 1, db });
    if (pending.length) return false;
    return await boss.send(name, job, { ...options, db }) !== null;
  });
}

// A write that leaves a document at 85% of its cap tidies it now instead of at 03:00.
export async function enqueueTidyIfFull(
  database: Database, ownerId: string, agentId: string, doc: MemoryDocument,
): Promise<void> {
  try {
    const { listMemory } = await import("./store");
    const view = await listMemory(database, ownerId, agentId);
    const target = doc === "user" ? view.user : doc === "memory" ? view.memory : view.private;
    if (!needsTidy(target.chars, target.cap)) return;
    const { docKeyFor } = await import("./schema");
    await enqueueMemoryTidy({ ownerId, agentId, doc, docKey: docKeyFor(doc, agentId) });
  } catch { /* a full document only misses a prompt tidy; the nightly run still finds it */ }
}

// Registers both workers on the shared boss instance. Called once by startRoutineScheduler.
export async function startMemoryWorkers(boss: PgBoss, database: Database): Promise<void> {
  // TASK-086/088. Workers must not start before their queues exist; the same boss instance is shared with the
  // routine scheduler, so this is idempotent.
  await getMemoryQueue();
  const { runMemoryReview } = await import("./review");
  const { runMemoryTidy } = await import("./tidy");
  await boss.work(MEMORY_REVIEW_QUEUE, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 5 }, async ([job]) => {
    const parsed = memoryReviewJobSchema.safeParse(job.data);
    if (!parsed.success) return;
    await runMemoryReview(database, parsed.data, job.id);
  });
  await boss.work(MEMORY_TIDY_QUEUE, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 5 }, async ([job]) => {
    const parsed = memoryTidyJobSchema.safeParse(job.data);
    if (!parsed.success) return;
    await runMemoryTidy(database, parsed.data, job.id);
  });
}
