import "server-only";

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { getDatabase } from "../../db/client";
import { memoryEntries, memoryReviewState, memoryVersions } from "../../db/schema";
import { appendAgentCard } from "../chat/data";
import { createCostedConnector } from "../costs/runtime";
import { createRunCostSink } from "../costs/store";
import { CostStopError } from "../costs/types";
import { recordAudit, type AuditExecutor } from "../security/audit";
import { contentWords, coverage } from "./gate";
import { resolveMemoryModel } from "./model";
import { scheduleMirror } from "./mirror";
import type { MemoryTidyJob } from "./queue";
import { capFor, docKeyFor, type MemoryDocument, type MemoryEntryView, type MemorySnapshotShape } from "./schema";

type Database = Awaited<ReturnType<typeof getDatabase>>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const MAX_OPS = 20;
export const TIDY_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const MIN_COVERAGE = 0.95;

const tidyOutputSchema = z.object({
  ops: z.array(z.discriminatedUnion("op", [
    z.object({ op: z.literal("merge"), ids: z.array(z.string().uuid()).min(2).max(5), title: z.string().trim().min(1).max(80), text: z.string().trim().min(1).max(600) }).strict(),
    z.object({ op: z.literal("shorten"), id: z.string().uuid(), text: z.string().trim().min(1).max(600) }).strict(),
    z.object({ op: z.literal("archive"), id: z.string().uuid(), reason: z.string().trim().min(1).max(120) }).strict(),
  ])).max(MAX_OPS),
}).strict();

const INSTRUCTIONS = [
  "You tidy one memory document. Merge duplicates, shorten wordy entries and archive stale or superseded ones.",
  "Never touch a pinned entry. Never invent facts: a merge or shorten may only use words already present in its sources.",
  "Return only JSON shaped as {\"ops\":[...]}. Allowed operations:",
  '{"op":"merge","ids":["<id>","<id>"],"title":"...","text":"..."}',
  '{"op":"shorten","id":"<id>","text":"..."}',
  '{"op":"archive","id":"<id>","reason":"..."}',
  "Code checks every word; an operation that adds words outside its sources is dropped.",
].join("\n");

const snapshotOf = (entry: MemoryEntryView): MemorySnapshotShape => ({
  title: entry.title, body: entry.body, pinned: entry.pinned, status: entry.status, scope: entry.scope, visibleTo: entry.visibleTo,
});

function parseJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

async function docEntries(database: Database | Transaction, ownerId: string, job: MemoryTidyJob): Promise<MemoryEntryView[]> {
  const targetAgent = job.doc === "user" ? null : job.agentId;
  const rows = await database.select().from(memoryEntries).where(and(
    eq(memoryEntries.ownerId, ownerId), eq(memoryEntries.doc, job.doc), eq(memoryEntries.status, "active"),
    targetAgent ? eq(memoryEntries.agentId, targetAgent) : sql`${memoryEntries.agentId} is null`,
  )).orderBy(desc(memoryEntries.pinned), desc(memoryEntries.lastConfirmedAt), desc(memoryEntries.updatedAt));
  return rows.map((row) => ({
    id: row.id, doc: row.doc as MemoryDocument, agentId: row.agentId, scope: row.scope as MemoryEntryView["scope"],
    visibleTo: row.visibleTo, title: row.title, body: row.body, pinned: row.pinned, trusted: row.trusted,
    status: row.status as MemoryEntryView["status"], author: row.author as MemoryEntryView["author"],
    sourceRunId: row.sourceRunId, sourceLabel: row.sourceLabel, version: row.version,
    lastConfirmedAt: row.lastConfirmedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  }));
}

async function nextSeq(transaction: Transaction, ownerId: string, docKey: string): Promise<number> {
  const last = await transaction.select({ seq: memoryVersions.seq }).from(memoryVersions)
    .where(and(eq(memoryVersions.ownerId, ownerId), eq(memoryVersions.docKey, docKey))).orderBy(desc(memoryVersions.seq)).limit(1);
  return (last[0]?.seq ?? 0) + 1;
}

async function appendTidyVersion(transaction: Transaction, ownerId: string, input: {
  docKey: string; entryId: string | null; agentId: string | null; op: "merge" | "shorten" | "archive" | "undo";
  before: MemorySnapshotShape | null; after: MemorySnapshotShape | null; batchId: string; reason?: string;
}): Promise<void> {
  await transaction.insert(memoryVersions).values({
    id: randomUUID(), ownerId, docKey: input.docKey, seq: await nextSeq(transaction, ownerId, input.docKey),
    entryId: input.entryId, agentId: input.agentId, op: input.op, before: input.before, after: input.after,
    author: "agent", authorAgentId: null, reason: input.reason ?? "Tidy", sourceRunId: null, batchId: input.batchId,
  });
}

// TASK-086. At 03:00 local or when a document passes 85% of its cap, at most once per 6 hours per document.
export async function runMemoryTidy(database: Database, job: MemoryTidyJob, jobId: string): Promise<void> {
  const now = new Date();
  const state = (await database.select({ lastTidyAt: memoryReviewState.lastTidyAt }).from(memoryReviewState)
    .where(and(eq(memoryReviewState.ownerId, job.ownerId), eq(memoryReviewState.agentId, job.agentId))).limit(1))[0];
  const lastTidy = state?.lastTidyAt && typeof state.lastTidyAt === "object" ? (state.lastTidyAt as Record<string, unknown>)[job.docKey] : null;
  if (typeof lastTidy === "string" && now.getTime() - Date.parse(lastTidy) < TIDY_INTERVAL_MS) return;

  const entries = await docEntries(database, job.ownerId, job);
  if (entries.length < 2) return;
  const model = await resolveMemoryModel(database, job.ownerId);
  if (!model) return;
  const costs = createRunCostSink({ database, ownerId: job.ownerId, agentId: job.agentId, backgroundJobId: jobId });
  const connector = createCostedConnector(model.connector, costs, { providerId: model.providerId, kind: model.kind, baseUrl: model.baseUrl });
  let result;
  try {
    result = await connector.generate({
      model: model.model,
      instructions: INSTRUCTIONS,
      messages: [{ role: "user", content: [{
        type: "text", sourceTag: "tool",
        text: JSON.stringify({
          document: job.doc, cap: capFor(job.doc), used: entries.reduce((sum, entry) => sum + entry.title.length + entry.body.length, 0),
          entries: entries.map((entry) => ({ id: entry.id, title: entry.title, body: entry.body, pinned: entry.pinned })),
        }),
      }] }],
      maxOutputTokens: 1_000,
      reasoningEffort: "low",
    });
  } catch (error) {
    if (error instanceof CostStopError) return;
    throw error;
  }
  const parsed = result.status === "completed" && result.text ? tidyOutputSchema.safeParse(parseJson(result.text)) : null;
  if (!parsed?.success || parsed.data.ops.length === 0) return;

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const batchId = randomUUID();
  const accepted: Array<{ op: "merge" | "shorten" | "archive"; ids: string[]; title?: string; text?: string; reason?: string }> = [];
  for (const op of parsed.data.ops) {
    if (op.op === "merge") {
      const sources = op.ids.map((id) => byId.get(id)).filter((entry): entry is MemoryEntryView => Boolean(entry));
      if (sources.length !== op.ids.length || new Set(op.ids).size !== op.ids.length || sources.some((entry) => entry.pinned)) continue;
      if (coverage(op.text, sources.map((entry) => `${entry.title} ${entry.body}`).join(" ")) < MIN_COVERAGE) continue;
      const others = entries.filter((entry) => !op.ids.includes(entry.id));
      if (others.some((entry) => entry.title.toLowerCase() === op.title.toLowerCase())) continue;
      if (others.reduce((sum, entry) => sum + entry.title.length + entry.body.length, 0) + op.title.length + op.text.length > capFor(job.doc)) continue;
      accepted.push({ op: "merge", ids: op.ids, title: op.title, text: op.text });
    } else if (op.op === "shorten") {
      const entry = byId.get(op.id);
      if (!entry || entry.pinned || contentWords(op.text).length === 0) continue;
      if (coverage(op.text, `${entry.title} ${entry.body}`) < MIN_COVERAGE) continue;
      accepted.push({ op: "shorten", ids: [op.id], text: op.text });
    } else {
      const entry = byId.get(op.id);
      if (!entry || entry.pinned) continue;
      accepted.push({ op: "archive", ids: [op.id], reason: op.reason });
    }
  }
  if (!accepted.length) return;

  const seenIds = new Set<string>();
  const distinctAccepted = accepted.filter((item) => {
    if (item.ids.some((id) => seenIds.has(id))) return false;
    for (const id of item.ids) seenIds.add(id);
    return true;
  });

  const merged = distinctAccepted.filter((item) => item.op === "merge").reduce((sum, item) => sum + item.ids.length, 0);
  const archived = distinctAccepted.filter((item) => item.op === "archive").length;
  const committed = await database.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${job.ownerId}), hashtext(${job.docKey}))`);
    const touchedIds = [...seenIds];
    const currentRows = await transaction.select({ id: memoryEntries.id, status: memoryEntries.status, pinned: memoryEntries.pinned, version: memoryEntries.version })
      .from(memoryEntries).where(and(eq(memoryEntries.ownerId, job.ownerId), inArray(memoryEntries.id, touchedIds))).for("update");
    const currentById = new Map(currentRows.map((entry) => [entry.id, entry]));
    if (touchedIds.some((id) => {
      const before = byId.get(id);
      const current = currentById.get(id);
      return !before || !current || current.status !== "active" || current.pinned || current.version !== before.version;
    })) return false;

    for (const item of distinctAccepted) {
      if (item.op === "merge") {
        const sources = item.ids.map((id) => byId.get(id)!);
        const [base, ...rest] = sources;
        const after: MemoryEntryView = { ...base, title: item.title!, body: item.text!, version: base.version + 1, updatedAt: new Date().toISOString() };
        await transaction.update(memoryEntries).set({ title: after.title, body: after.body, version: after.version, updatedAt: new Date(), lastConfirmedAt: new Date() })
          .where(and(eq(memoryEntries.ownerId, job.ownerId), eq(memoryEntries.id, base.id)));
        await appendTidyVersion(transaction, job.ownerId, { docKey: job.docKey, entryId: base.id, agentId: base.agentId, op: "merge", before: snapshotOf(base), after: snapshotOf(after), batchId });
        for (const entry of rest) {
          await transaction.update(memoryEntries).set({ status: "archived", version: entry.version + 1, updatedAt: new Date() })
            .where(and(eq(memoryEntries.ownerId, job.ownerId), eq(memoryEntries.id, entry.id)));
          await appendTidyVersion(transaction, job.ownerId, { docKey: job.docKey, entryId: entry.id, agentId: entry.agentId, op: "archive", before: snapshotOf(entry), after: null, batchId, reason: `Merged into ${item.title}` });
        }
      } else if (item.op === "shorten") {
        const entry = byId.get(item.ids[0])!;
        const after: MemoryEntryView = { ...entry, body: item.text!, version: entry.version + 1, updatedAt: new Date().toISOString() };
        await transaction.update(memoryEntries).set({ body: after.body, version: after.version, updatedAt: new Date(), lastConfirmedAt: new Date() })
          .where(and(eq(memoryEntries.ownerId, job.ownerId), eq(memoryEntries.id, entry.id)));
        await appendTidyVersion(transaction, job.ownerId, { docKey: job.docKey, entryId: entry.id, agentId: entry.agentId, op: "shorten", before: snapshotOf(entry), after: snapshotOf(after), batchId });
      } else {
        const entry = byId.get(item.ids[0])!;
        await transaction.update(memoryEntries).set({ status: "archived", version: entry.version + 1, updatedAt: new Date() })
          .where(and(eq(memoryEntries.ownerId, job.ownerId), eq(memoryEntries.id, entry.id)));
        await appendTidyVersion(transaction, job.ownerId, { docKey: job.docKey, entryId: entry.id, agentId: entry.agentId, op: "archive", before: snapshotOf(entry), after: null, batchId, reason: item.reason });
      }
    }
    return true;
  });
  if (!committed) return;
  await recordAudit(database as unknown as AuditExecutor, job.ownerId, { kind: "memory_tidied", agentId: job.agentId, ref: batchId }).catch(() => undefined);
  try {
    await appendAgentCard(database, job.ownerId, job.agentId, {
      card: { type: "memory_tidied", batchId, merged, archived, doc: job.doc }, sourceTag: "agent",
    });
  } catch { /* the Memory tab still shows the batch */ }
  void scheduleMirror(database, job.ownerId, job.doc === "user" ? null : job.agentId).catch(() => undefined);
  await database.insert(memoryReviewState).values({ agentId: job.agentId, ownerId: job.ownerId, lastTidyAt: { [job.docKey]: now.toISOString() }, updatedAt: now })
    .onConflictDoUpdate({
      target: memoryReviewState.agentId,
      set: { lastTidyAt: sql`${memoryReviewState.lastTidyAt} || ${JSON.stringify({ [job.docKey]: now.toISOString() })}::jsonb`, updatedAt: now },
    });
}

// One card, one Undo: restores every entry a tidy batch touched, newest version first.
export async function undoMemoryBatch(database: Database, ownerId: string, batchId: string): Promise<{ ok: true; count: number } | { ok: false; error: "not_found" | "conflict" }> {
  let mirrorAgent: string | null = null;
  const result = await database.transaction(async (transaction): Promise<{ ok: true; count: number } | { ok: false; error: "not_found" | "conflict" }> => {
    const rows = await transaction.select().from(memoryVersions)
      .where(and(eq(memoryVersions.ownerId, ownerId), eq(memoryVersions.batchId, batchId))).orderBy(desc(memoryVersions.seq));
    if (!rows.length) return { ok: false, error: "not_found" };
    if (rows.some((version) => version.op === "undo")) return { ok: false, error: "not_found" };
    mirrorAgent = rows[0].agentId;
    for (const docKey of [...new Set(rows.map((version) => version.docKey))].sort()) {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ownerId}), hashtext(${docKey}))`);
    }
    // The batch's newest version per entry must still be the latest version, or the entry changed since the tidy ran.
    const newestByEntry = new Map<string, (typeof rows)[number]>();
    for (const version of rows) {
      if (version.entryId && !newestByEntry.has(version.entryId)) newestByEntry.set(version.entryId, version);
    }
    for (const [entryId, batchNewest] of newestByEntry) {
      const current = (await transaction.select().from(memoryEntries)
        .where(and(eq(memoryEntries.ownerId, ownerId), eq(memoryEntries.id, entryId))).limit(1))[0];
      if (!current) continue;
      if (current.pinned) return { ok: false, error: "conflict" };
      const latest = (await transaction.select({ id: memoryVersions.id }).from(memoryVersions)
        .where(and(eq(memoryVersions.ownerId, ownerId), eq(memoryVersions.entryId, entryId)))
        .orderBy(desc(memoryVersions.seq)).limit(1))[0];
      if (!latest || latest.id !== batchNewest.id) return { ok: false, error: "conflict" };
    }
    const restoredByDoc = new Map<string, { doc: MemoryDocument; agentId: string | null; entries: { id: string; title: string; body: string }[] }>();
    for (const [entryId, version] of newestByEntry) {
      if (!version.before) continue;
      const before = version.before as MemorySnapshotShape;
      const doc = version.docKey === "user" ? "user" : version.docKey.endsWith(":memory") ? "memory" : "private";
      const group = restoredByDoc.get(version.docKey) ?? { doc, agentId: version.agentId, entries: [] };
      group.entries.push({ id: entryId, title: before.title, body: before.body });
      restoredByDoc.set(version.docKey, group);
    }
    for (const restored of restoredByDoc.values()) {
      const conditions = [eq(memoryEntries.ownerId, ownerId), eq(memoryEntries.doc, restored.doc)];
      if (restored.doc !== "user" && restored.agentId) conditions.push(eq(memoryEntries.agentId, restored.agentId));
      const documentRows = await transaction.select({ id: memoryEntries.id, title: memoryEntries.title, body: memoryEntries.body, status: memoryEntries.status })
        .from(memoryEntries).where(and(...conditions));
      const batchEntryIds = new Set(newestByEntry.keys());
      const existingIds = new Set(documentRows.map((entry) => entry.id));
      const liveOutsideBatch = documentRows.filter((entry) => entry.status === "active" && !batchEntryIds.has(entry.id));
      const restorable = restored.entries.filter((entry) => existingIds.has(entry.id));
      const outsideTitles = new Set(liveOutsideBatch.map((entry) => entry.title.toLowerCase()));
      if (restorable.some((entry) => outsideTitles.has(entry.title.toLowerCase()))) return { ok: false, error: "conflict" };
      const totalChars = liveOutsideBatch.reduce((sum, entry) => sum + entry.title.length + entry.body.length, 0) +
        restorable.reduce((sum, entry) => sum + entry.title.length + entry.body.length, 0);
      if (totalChars > capFor(restored.doc)) return { ok: false, error: "conflict" };
    }
    let count = 0;
    for (const version of rows) {
      if (!version.entryId || !version.before) continue;
      const before = version.before as MemorySnapshotShape;
      const current = (await transaction.select().from(memoryEntries)
        .where(and(eq(memoryEntries.ownerId, ownerId), eq(memoryEntries.id, version.entryId))).limit(1))[0];
      if (!current) continue;
      await transaction.update(memoryEntries).set({
        title: before.title, body: before.body, pinned: before.pinned, visibleTo: before.visibleTo,
        status: "active", version: current.version + 1, updatedAt: new Date(),
      }).where(and(eq(memoryEntries.ownerId, ownerId), eq(memoryEntries.id, version.entryId)));
      await appendTidyVersion(transaction, ownerId, {
        docKey: version.docKey, entryId: version.entryId, agentId: version.agentId, op: "undo",
        before: { title: current.title, body: current.body, pinned: current.pinned, status: current.status, scope: current.scope, visibleTo: current.visibleTo },
        after: before, batchId, reason: "Undo tidy",
      });
      count += 1;
    }
    await recordAudit(transaction as unknown as AuditExecutor, ownerId, {
      kind: "memory_undone", agentId: mirrorAgent, ref: batchId,
    });
    return { ok: true, count };
  });
  if (result.ok) void scheduleMirror(database, ownerId, mirrorAgent).catch(() => undefined);
  return result;
}

export function tidyDocKey(doc: MemoryDocument, agentId: string): string { return docKeyFor(doc, agentId); }
