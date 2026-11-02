import "server-only";

import { and, asc, desc, eq, gte, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { getDatabase } from "../../db/client";
import { agents, approvals, costEntries, messages, runMeta, runs, steps } from "../../db/schema";
import { chatCardSchema } from "../chat/schema";
import {
  decodeCursor, END_NOTE, encodeCursor, escapeLike, outcomeOf, rangeStart, readRunHeader, triggerOf,
  type JobAttempt, type JobDetailView, type JobListQuery, type JobRow, type JobStepError,
} from "./view";

type Database = Awaited<ReturnType<typeof getDatabase>>;

export const JOB_PAGE_SIZE = 25;
const SCAN_BATCH = 100;
const MAX_SCAN_BATCHES = 10;
const MAX_ATTEMPTS = 20;
const MAX_OUTPUT_CHARS = 4_000;
const MAX_FILES = 20;

const runColumns = {
  id: runs.id,
  agentId: runs.agentId,
  headerJson: runs.headerJson,
  startedAt: runs.startedAt,
  endedAt: runs.endedAt,
  status: runs.status,
  signature: runs.signature,
  trigger: runMeta.trigger,
  routineId: runMeta.routineId,
  label: runMeta.label,
  astraMode: agents.astraMode,
};
type RunJoinRow = {
  id: string; agentId: string; headerJson: string; startedAt: Date; endedAt: Date | null;
  status: string; signature: string | null; trigger: string | null; routineId: string | null; label: string | null;
  astraMode: boolean | null;
};

async function buildRows(database: Database, ownerId: string, rows: RunJoinRow[], now: Date): Promise<JobRow[]> {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const stepRows = await database.select({ runId: steps.runId, idx: steps.idx, receiptJson: steps.receiptJson }).from(steps)
    .where(and(eq(steps.ownerId, ownerId), inArray(steps.runId, ids))).orderBy(asc(steps.idx));
  const byRun = new Map<string, string[]>();
  for (const row of stepRows) {
    let result = "unknown";
    try { const value = JSON.parse(row.receiptJson) as { result?: unknown }; if (typeof value.result === "string") result = value.result; } catch { /* unknown */ }
    byRun.set(row.runId, [...(byRun.get(row.runId) ?? []), result]);
  }
  const costRows = await database.select({
    runId: costEntries.runId,
    cost: sql<string | null>`sum(${costEntries.costMicroUsd})`,
  }).from(costEntries)
    .where(and(eq(costEntries.ownerId, ownerId), inArray(costEntries.runId, ids)))
    .groupBy(costEntries.runId);
  const costByRun = new Map(costRows.map((row) => [row.runId, Number(row.cost ?? 0)]));
  // TASK-050. A live run waiting on an approval says so instead of the generic "Running".
  const waitingRows = await database.select({ runId: approvals.runId }).from(approvals)
    .where(and(eq(approvals.ownerId, ownerId), inArray(approvals.runId, ids), eq(approvals.state, "pending")));
  const waiting = new Set(waitingRows.map((row) => row.runId));

  return rows.map((row) => {
    const header = readRunHeader(row.headerJson);
    const results = byRun.get(row.id) ?? [];
    const outcome = outcomeOf({ status: row.status, sealed: row.signature !== null, startedAt: row.startedAt, endedAt: row.endedAt, stepResults: results, now,
      waitingForApproval: waiting.has(row.id) });
    const task = header.task || "Untitled task";
    return {
      runId: row.id,
      agentId: row.agentId,
      agentName: header.agentName || "Unknown agent",
      astraMode: row.astraMode === true,
      routineId: row.routineId ?? null,
      label: row.label ?? task,
      trigger: triggerOf(row.trigger, header.task),
      startedAt: row.startedAt.toISOString(),
      endedAt: row.endedAt?.toISOString() ?? null,
      durationMs: row.endedAt ? Math.max(0, row.endedAt.getTime() - row.startedAt.getTime())
        : outcome.outcome === "running" ? Math.max(0, now.getTime() - row.startedAt.getTime()) : null,
      stepCount: results.length,
      costMicroUsd: costByRun.get(row.id) ?? 0,
      outcome: outcome.outcome,
      outcomeLabel: outcome.label,
      tone: outcome.tone,
    };
  });
}

function matchesOutcome(row: JobRow, filter: JobListQuery["outcome"]): boolean {
  return filter === "all" || row.outcome === filter;
}

export async function listJobs(
  database: Database, ownerId: string, query: JobListQuery, now = new Date(),
): Promise<{ jobs: JobRow[]; nextCursor: string | null }> {
  const base: SQL[] = [eq(runs.ownerId, ownerId)];
  const start = rangeStart(query.range, now);
  if (start) base.push(gte(runs.startedAt, start));
  if (query.agent) base.push(eq(runs.agentId, query.agent));
  if (query.q) {
    const pattern = `%${escapeLike(query.q)}%`;
    const search = or(sql`${runs.headerJson} ilike ${pattern}`, sql`${runMeta.label} ilike ${pattern}`);
    if (search) base.push(search);
  }

  let cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !cursor) throw new Error("invalid_cursor");

  const jobs: JobRow[] = [];
  let nextCursor: string | null = null;
  for (let batch = 0; batch < MAX_SCAN_BATCHES && jobs.length < JOB_PAGE_SIZE; batch++) {
    const conditions = [...base];
    if (cursor) {
      const after = or(
        lt(runs.startedAt, cursor.startedAt),
        and(eq(runs.startedAt, cursor.startedAt), lt(runs.id, cursor.id)),
      );
      if (after) conditions.push(after);
    }
    const rows = await database.select(runColumns).from(runs)
      .leftJoin(runMeta, and(eq(runMeta.runId, runs.id), eq(runMeta.ownerId, ownerId)))
      .leftJoin(agents, and(eq(agents.id, runs.agentId), eq(agents.ownerId, ownerId)))
      .where(and(...conditions))
      .orderBy(desc(runs.startedAt), desc(runs.id))
      .limit(SCAN_BATCH) as RunJoinRow[];
    if (!rows.length) break;
    const built = await buildRows(database, ownerId, rows, now);
    let lastIncluded: RunJoinRow | null = null;
    for (let index = 0; index < built.length; index++) {
      if (!matchesOutcome(built[index], query.outcome)) continue;
      jobs.push(built[index]);
      lastIncluded = rows[index];
      if (jobs.length === JOB_PAGE_SIZE) break;
    }
    const last = rows[rows.length - 1];
    cursor = { startedAt: last.startedAt, id: last.id };
    if (jobs.length === JOB_PAGE_SIZE) {
      nextCursor = encodeCursor(lastIncluded ?? last);
      break;
    }
    if (rows.length < SCAN_BATCH) break;
    if (batch === MAX_SCAN_BATCHES - 1) nextCursor = encodeCursor(last);
  }
  return { jobs, nextCursor };
}

async function chainIds(database: Database, ownerId: string, runId: string): Promise<string[]> {
  let root = runId;
  for (let depth = 0; depth < MAX_ATTEMPTS; depth++) {
    const rows = await database.select({ retryOf: runMeta.retryOf }).from(runMeta)
      .where(and(eq(runMeta.ownerId, ownerId), eq(runMeta.runId, root))).limit(1);
    const parent = rows[0]?.retryOf;
    if (!parent) break;
    root = parent;
  }
  const chain = [root];
  for (let depth = 1; depth < MAX_ATTEMPTS; depth++) {
    const rows = await database.select({ runId: runMeta.runId }).from(runMeta)
      .where(and(eq(runMeta.ownerId, ownerId), eq(runMeta.retryOf, chain[chain.length - 1]))).limit(1);
    if (!rows[0]) break;
    chain.push(rows[0].runId);
  }
  return chain;
}

export async function listAttempts(database: Database, ownerId: string, runId: string, now = new Date()): Promise<JobAttempt[]> {
  const ids = await chainIds(database, ownerId, runId);
  if (ids.length < 2) return [];
  const rows = await database.select(runColumns).from(runs)
    .leftJoin(runMeta, and(eq(runMeta.runId, runs.id), eq(runMeta.ownerId, ownerId)))
    .leftJoin(agents, and(eq(agents.id, runs.agentId), eq(agents.ownerId, ownerId)))
    .where(and(eq(runs.ownerId, ownerId), inArray(runs.id, ids))) as RunJoinRow[];
  const built = await buildRows(database, ownerId, rows, now);
  const order = new Map(ids.map((id, index) => [id, index]));
  return built
    .sort((left, right) => (order.get(left.runId) ?? 0) - (order.get(right.runId) ?? 0))
    .map((row) => ({
      runId: row.runId, startedAt: row.startedAt, endedAt: row.endedAt,
      outcome: row.outcome, outcomeLabel: row.outcomeLabel, tone: row.tone,
    }));
}

async function loadJobIo(database: Database, ownerId: string, runId: string, input: string) {
  const rows = await database.select({ role: messages.role, content: messages.content }).from(messages)
    .where(and(eq(messages.ownerId, ownerId), eq(messages.runId, runId)))
    .orderBy(asc(messages.createdAt), asc(messages.id)).limit(100);
  let output = "";
  const files = new Set<string>();
  for (const row of rows) {
    const card = chatCardSchema.safeParse(row.content);
    if (!card.success) continue;
    if (row.role === "agent" && card.data.type === "message") output = card.data.text;
    if (card.data.type === "file" && card.data.direction === "outbox") files.add(card.data.name);
  }
  return { input: input.slice(0, MAX_OUTPUT_CHARS), output: output.slice(0, MAX_OUTPUT_CHARS), files: [...files].slice(0, MAX_FILES) };
}

const receiptErrorSchema = z.object({
  result: z.string().max(20).optional(),
  code: z.string().max(80).nullable().optional(),
}).passthrough();

async function loadJobErrors(database: Database, ownerId: string, runId: string): Promise<JobStepError[]> {
  const rows = await database.select({ idx: steps.idx, receiptJson: steps.receiptJson }).from(steps)
    .where(and(eq(steps.ownerId, ownerId), eq(steps.runId, runId))).orderBy(asc(steps.idx)).limit(100);
  const errors: JobStepError[] = [];
  for (const row of rows) {
    let parsed: z.infer<typeof receiptErrorSchema> | null = null;
    try { const value = receiptErrorSchema.safeParse(JSON.parse(row.receiptJson)); parsed = value.success ? value.data : null; } catch { parsed = null; }
    const result = parsed?.result ?? "unknown";
    if (result !== "fail" && result !== "failed" && result !== "blocked" && result !== "unknown") continue;
    errors.push({ idx: row.idx, result, code: parsed?.code ?? null });
  }
  return errors;
}

export async function loadJob(database: Database, ownerId: string, runId: string, now = new Date()): Promise<JobDetailView | null> {
  const rows = await database.select(runColumns).from(runs)
    .leftJoin(runMeta, and(eq(runMeta.runId, runs.id), eq(runMeta.ownerId, ownerId)))
    .leftJoin(agents, and(eq(agents.id, runs.agentId), eq(agents.ownerId, ownerId)))
    .where(and(eq(runs.ownerId, ownerId), eq(runs.id, runId))).limit(1) as RunJoinRow[];
  if (!rows[0]) return null;
  const [summary] = await buildRows(database, ownerId, rows, now);
  const header = readRunHeader(rows[0].headerJson);
  const [attempts, io, errors] = await Promise.all([
    listAttempts(database, ownerId, runId, now),
    loadJobIo(database, ownerId, runId, header.task),
    loadJobErrors(database, ownerId, runId),
  ]);
  return {
    summary,
    attempts,
    input: io.input,
    output: io.output,
    files: io.files,
    errors,
    endNote: rows[0].signature ? END_NOTE[rows[0].status] ?? null : null,
  };
}

// The retry route needs the signed task, the agent and the current outcome for one owner-scoped run.
export async function loadRunForAction(database: Database, ownerId: string, runId: string, now = new Date()) {
  const rows = await database.select(runColumns).from(runs)
    .leftJoin(runMeta, and(eq(runMeta.runId, runs.id), eq(runMeta.ownerId, ownerId)))
    .leftJoin(agents, and(eq(agents.id, runs.agentId), eq(agents.ownerId, ownerId)))
    .where(and(eq(runs.ownerId, ownerId), eq(runs.id, runId))).limit(1) as RunJoinRow[];
  if (!rows[0]) return null;
  const [summary] = await buildRows(database, ownerId, rows, now);
  const header = readRunHeader(rows[0].headerJson);
  return {
    summary, task: header.task, sealed: rows[0].signature !== null,
    trigger: triggerOf(rows[0].trigger, header.task), routineId: rows[0].routineId ?? null,
  };
}

// True when a newer retry already points at this run, so Retry stays a one-shot action per attempt.
export async function hasNewerAttempt(database: Database, ownerId: string, runId: string): Promise<boolean> {
  const rows = await database.select({ runId: runMeta.runId }).from(runMeta)
    .where(and(eq(runMeta.ownerId, ownerId), eq(runMeta.retryOf, runId))).limit(1);
  return Boolean(rows[0]);
}
