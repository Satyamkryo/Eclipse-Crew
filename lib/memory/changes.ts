import "server-only";

import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { agentPolicies, memoryChanges, memoryEntries, memoryVersions } from "../../db/schema";
import { appendAgentCard } from "../chat/data";
import { refreshApprovalAttention, expiredChange } from "../approvals/attention";
import { recordAudit, type AuditExecutor } from "../security/audit";
import { scheduleMirror } from "./mirror";
import { scanMemoryText } from "./scan";
import { capFor, type MemoryDocument } from "./schema";
import { applyMemoryChangeWithin } from "./store";
import { checkOrigin } from "./gate";

type Database = Awaited<ReturnType<typeof getDatabase>>;

export const MAX_REQUESTS_PER_RUN = 3;
export const MAX_PENDING_PER_AGENT = 20;

export type RememberOp = "add" | "replace" | "forget";

export interface ProposeInput {
  ownerId: string; agentId: string; runId: string | null;
  scope: "global" | "agent" | "private"; title: string; body: string; reason: string;
  op?: RememberOp;
  // The owner's exact words. Code verifies it is a real owner message; the model's claim is never trusted.
  quote?: string | null;
  queuedThisRun: number;
}

export type ProposeResult =
  | { ok: true; changeId: string; flags: string[]; applied: boolean; versionId?: string }
  | { ok: false; code: "scope_denied" | "too_many_for_run" | "too_many_pending" | "duplicate_title" | "rejected" | "not_found" | "pinned"; codes?: string[] };

const DOC_FOR_SCOPE: Record<ProposeInput["scope"], MemoryDocument> = { global: "user", agent: "memory", private: "private" };

export async function proposeMemory(database: Database, input: ProposeInput): Promise<ProposeResult> {
  if (input.queuedThisRun >= MAX_REQUESTS_PER_RUN) return { ok: false, code: "too_many_for_run" };
  const policy = await database.select({ memoryScopes: agentPolicies.memoryScopes, memoryMode: agentPolicies.memoryMode }).from(agentPolicies)
    .where(and(eq(agentPolicies.ownerId, input.ownerId), eq(agentPolicies.agentId, input.agentId))).limit(1);
  if (!policy[0] || !policy[0].memoryScopes.includes(input.scope)) return { ok: false, code: "scope_denied" };
  const pending = await database.select({ count: sql<string>`count(*)` }).from(memoryChanges)
    .where(and(eq(memoryChanges.ownerId, input.ownerId), eq(memoryChanges.agentId, input.agentId), eq(memoryChanges.state, "pending")));
  if (Number(pending[0]?.count ?? 0) >= MAX_PENDING_PER_AGENT) return { ok: false, code: "too_many_pending" };

  const scanned = scanMemoryText({ title: input.title, text: input.body, reason: input.reason });
  if (scanned.verdict === "rejected") return { ok: false, code: "rejected", codes: scanned.codes };

  const op = input.op ?? "add";
  const doc = DOC_FOR_SCOPE[input.scope];
  const targetAgent = doc === "user" ? null : input.agentId;
  const entries = await database.select({ id: memoryEntries.id, title: memoryEntries.title, body: memoryEntries.body, pinned: memoryEntries.pinned }).from(memoryEntries).where(and(
    eq(memoryEntries.ownerId, input.ownerId), eq(memoryEntries.doc, doc), eq(memoryEntries.status, "active"),
    targetAgent ? eq(memoryEntries.agentId, targetAgent) : sql`${memoryEntries.agentId} is null`,
  ));
  const title = input.title.toLowerCase();
  const existing = entries.find((entry) => entry.title.toLowerCase() === title) ?? null;
  if (op !== "add") {
    if (!existing) return { ok: false, code: "not_found" };
    if (existing.pinned) return { ok: false, code: "pinned" };
  }

  if (op === "add") {
    const requests = await database.select({ title: memoryChanges.title }).from(memoryChanges).where(and(
      eq(memoryChanges.ownerId, input.ownerId), eq(memoryChanges.agentId, input.agentId), eq(memoryChanges.state, "pending"),
      eq(memoryChanges.doc, doc),
    ));
    if (existing || requests.some((entry) => entry.title.toLowerCase() === title)) return { ok: false, code: "duplicate_title" };
  }

  // TASK-086. The origin gate. Only the owner's own stored message can make a change apply without asking.
  const gateText = op === "forget" ? existing?.body ?? input.body : input.body;
  const gate = await checkOrigin(database, input.ownerId, { title: input.title, text: gateText, quote: input.quote }, policy[0].memoryMode as "auto" | "ask");
  if (gate.decision === "auto") {
    const change = op === "add"
      ? { op: "add" as const, doc, agentId: targetAgent, title: input.title, body: input.body, author: "agent" as const, authorAgentId: input.agentId,
          trusted: true, reason: input.reason, sourceRunId: input.runId, sourceLabel: "From your message" }
      : op === "replace"
        ? { op: "edit" as const, entryId: existing!.id, body: input.body, author: "agent" as const, authorAgentId: input.agentId,
            reason: input.reason, sourceRunId: input.runId }
        : { op: "remove" as const, entryId: existing!.id, author: "agent" as const, authorAgentId: input.agentId,
            reason: input.reason, sourceRunId: input.runId };
    const applied = await database.transaction(async (transaction) => {
      const result = await applyMemoryChangeWithin(transaction, input.ownerId, change);
      if (!result.ok) return result;
      await recordAudit(transaction as unknown as AuditExecutor, input.ownerId, {
        kind: "memory_auto_saved", agentId: input.agentId, runId: input.runId, ref: result.versionId,
      });
      return result;
    });
    if (!applied.ok) return { ok: false, code: applied.error === "duplicate_title" ? "duplicate_title" : applied.error === "not_found" ? "not_found" : "rejected" };
    try {
      await appendAgentCard(database, input.ownerId, input.agentId, {
        card: { type: "memory_saved", versionId: applied.versionId, title: applied.entry.title, op, doc, scope: input.scope },
        sourceTag: "agent", ...(input.runId ? { runId: input.runId } : {}),
      });
    } catch { /* the Memory tab still shows the entry and its Undo */ }
    return { ok: true, changeId: applied.versionId, flags: scanned.codes, applied: true, versionId: applied.versionId };
  }

  const changeId = randomUUID();
  const storedQuote = typeof input.quote === "string" && input.quote.trim().length >= 12 ? input.quote.trim().slice(0, 600) : null;
  await database.insert(memoryChanges).values({
    id: changeId, ownerId: input.ownerId, agentId: input.agentId, runId: input.runId, doc, scope: input.scope,
    op, quote: storedQuote, title: existing?.title ?? input.title, body: op === "forget" ? existing!.body : input.body,
    reason: input.reason, flags: scanned.codes,
  });
  try {
    await appendAgentCard(database, input.ownerId, input.agentId, {
      card: { type: "memory_change", changeId, doc, scope: input.scope, title: existing?.title ?? input.title },
      sourceTag: "agent", ...(input.runId ? { runId: input.runId } : {}),
    });
  } catch { /* the Change requests tab still shows it */ }
  await refreshApprovalAttention(database, input.ownerId, input.agentId).catch(() => undefined);
  return { ok: true, changeId, flags: scanned.codes, applied: false };
}

export interface MemoryChangeRow {
  id: string; agentId: string; runId: string | null; doc: MemoryDocument; scope: ProposeInput["scope"];
  op: RememberOp; quote: string | null;
  title: string; body: string; reason: string; flags: string[]; state: "pending" | "approved" | "rejected";
  resultVersionId: string | null; createdAt: string; decidedAt: string | null; expired: boolean;
}

function toChange(row: typeof memoryChanges.$inferSelect): MemoryChangeRow {
  return {
    id: row.id, agentId: row.agentId, runId: row.runId, doc: row.doc as MemoryDocument, scope: row.scope as ProposeInput["scope"],
    op: row.op as RememberOp, quote: row.quote,
    title: row.title, body: row.body, reason: row.reason, flags: row.flags, state: row.state as MemoryChangeRow["state"],
    resultVersionId: row.resultVersionId, createdAt: row.createdAt.toISOString(), decidedAt: row.decidedAt?.toISOString() ?? null,
    expired: row.state === "pending" && expiredChange(row.createdAt),
  };
}

export async function listPending(database: Database, ownerId: string, agentId?: string, state: "pending" | "all" = "pending"): Promise<MemoryChangeRow[]> {
  const conditions = [eq(memoryChanges.ownerId, ownerId)];
  if (agentId) conditions.push(eq(memoryChanges.agentId, agentId));
  if (state === "pending") conditions.push(eq(memoryChanges.state, "pending"));
  const rows = await database.select().from(memoryChanges).where(and(...conditions)).orderBy(desc(memoryChanges.createdAt)).limit(100);
  return rows.map(toChange);
}

export async function getChange(database: Database, ownerId: string, changeId: string): Promise<MemoryChangeRow | null> {
  const rows = await database.select().from(memoryChanges)
    .where(and(eq(memoryChanges.ownerId, ownerId), eq(memoryChanges.id, changeId))).limit(1);
  return rows[0] ? toChange(rows[0]) : null;
}

export type DecideChangeResult =
  | { ok: true; state: "approved" | "rejected"; versionId?: string }
  | { ok: false; error: "not_found" | "already_decided" | "expired" | "scan_rejected" | "over_cap" | "duplicate_title" | "invalid_visible_to" | "pinned" };

export async function decideMemoryChange(
  database: Database, ownerId: string, changeId: string, decision: "approve" | "reject",
): Promise<DecideChangeResult> {
  let agentId: string | null = null;
  let changeDoc: MemoryDocument | null = null;
  const result = await database.transaction(async (transaction): Promise<DecideChangeResult> => {
    const rows = await transaction.select().from(memoryChanges)
      .where(and(eq(memoryChanges.ownerId, ownerId), eq(memoryChanges.id, changeId))).limit(1).for("update");
    const change = rows[0];
    if (!change) return { ok: false, error: "not_found" };
    agentId = change.agentId;
    changeDoc = change.doc as MemoryDocument;
    if (change.state !== "pending") return { ok: false, error: "already_decided" };
    if (expiredChange(change.createdAt)) return { ok: false, error: "expired" };

    if (decision === "reject") {
      await transaction.update(memoryChanges).set({ state: "rejected", decidedAt: new Date() })
        .where(and(eq(memoryChanges.ownerId, ownerId), eq(memoryChanges.id, changeId)));
      await recordAudit(transaction as unknown as AuditExecutor, ownerId, {
        kind: "memory_rejected", agentId: change.agentId, runId: change.runId, ref: change.id,
      });
      return { ok: true, state: "rejected" };
    }

    // Re-scan at approval time: the pattern list may have changed, and the text is the same untrusted text.
    const scanned = scanMemoryText({ title: change.title, text: change.body, reason: change.reason });
    if (scanned.verdict === "rejected") {
      await transaction.update(memoryChanges).set({ state: "rejected", decidedAt: new Date() })
        .where(and(eq(memoryChanges.ownerId, ownerId), eq(memoryChanges.id, changeId)));
      await recordAudit(transaction as unknown as AuditExecutor, ownerId, {
        kind: "memory_rejected", agentId: change.agentId, runId: change.runId, ref: change.id, code: "scan_rejected",
      });
      return { ok: false, error: "scan_rejected" };
    }
    let applied: Awaited<ReturnType<typeof applyMemoryChangeWithin>>;
    if (change.op === "add") {
      applied = await applyMemoryChangeWithin(transaction, ownerId, {
        op: "add", doc: change.doc as MemoryDocument, agentId: change.doc === "user" ? null : change.agentId,
        title: change.title, body: change.body, author: "agent", authorAgentId: change.agentId, trusted: false,
        reason: change.reason, sourceRunId: change.runId, sourceLabel: "Agent request",
      });
    } else {
      // replace and forget name an existing entry by its exact title from the snapshot. Pinned entries never change.
      const targetAgent = change.doc === "user" ? null : change.agentId;
      const target = await transaction.select({ id: memoryEntries.id, pinned: memoryEntries.pinned }).from(memoryEntries).where(and(
        eq(memoryEntries.ownerId, ownerId), eq(memoryEntries.doc, change.doc), eq(memoryEntries.status, "active"),
        targetAgent ? eq(memoryEntries.agentId, targetAgent) : sql`${memoryEntries.agentId} is null`,
        sql`lower(${memoryEntries.title}) = lower(${change.title})`,
      )).limit(1);
      if (!target[0]) return { ok: false, error: "not_found" };
      if (target[0].pinned) return { ok: false, error: "pinned" };
      applied = await applyMemoryChangeWithin(transaction, ownerId, change.op === "replace"
        ? { op: "edit", entryId: target[0].id, body: change.body, author: "agent", authorAgentId: change.agentId, reason: change.reason, sourceRunId: change.runId }
        : { op: "remove", entryId: target[0].id, author: "agent", authorAgentId: change.agentId, reason: change.reason, sourceRunId: change.runId });
    }
    if (!applied.ok) return { ok: false, error: applied.error === "over_cap" ? "over_cap" : applied.error === "duplicate_title" ? "duplicate_title" : applied.error === "invalid_visible_to" ? "invalid_visible_to" : "not_found" };
    await transaction.update(memoryChanges).set({ state: "approved", resultVersionId: applied.versionId, decidedAt: new Date() })
      .where(and(eq(memoryChanges.ownerId, ownerId), eq(memoryChanges.id, changeId)));
    await recordAudit(transaction as unknown as AuditExecutor, ownerId, {
      kind: "memory_approved", agentId: change.agentId, runId: change.runId, ref: change.id,
    });
    return { ok: true, state: "approved", versionId: applied.versionId };
  });
  if (agentId) {
    await refreshApprovalAttention(database, ownerId, agentId).catch(() => undefined);
    void scheduleMirror(database, ownerId, agentId).catch(() => undefined);
    if (result.ok && changeDoc) {
      void import("./queue").then(({ enqueueTidyIfFull }) => enqueueTidyIfFull(database, ownerId, agentId!, changeDoc!)).catch(() => undefined);
    }
  }
  return result;
}

export type UndoResult =
  | { ok: true; entryId: string; versionId: string }
  | { ok: false; error: "not_found" | "not_latest" | "pinned" | "over_cap" | "duplicate_title" };

// TASK-054. Undo appends a new version that restores the state before `versionId`. History is never rewritten.
export async function undoMemoryVersion(database: Database, ownerId: string, versionId: string): Promise<UndoResult> {
  let agentId: string | null = null;
  const result = await database.transaction(async (transaction): Promise<UndoResult> => {
    const versionRows = await transaction.select().from(memoryVersions)
      .where(and(eq(memoryVersions.ownerId, ownerId), eq(memoryVersions.id, versionId))).limit(1);
    const version = versionRows[0];
    if (!version || !version.entryId) return { ok: false, error: "not_found" };
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ownerId}), hashtext(${version.docKey}))`);

    const latest = await transaction.select({ id: memoryVersions.id }).from(memoryVersions)
      .where(and(eq(memoryVersions.ownerId, ownerId), eq(memoryVersions.entryId, version.entryId)))
      .orderBy(desc(memoryVersions.seq)).limit(1);
    if (!latest[0] || latest[0].id !== versionId) return { ok: false, error: "not_latest" };

    const entryRows = await transaction.select().from(memoryEntries)
      .where(and(eq(memoryEntries.ownerId, ownerId), eq(memoryEntries.id, version.entryId))).limit(1);
    const entry = entryRows[0];
    if (!entry) return { ok: false, error: "not_found" };
    agentId = entry.agentId;
    const before = (version.before as { title: string; body: string; pinned: boolean; status: string; scope: string; visibleTo: string[] } | null) ?? null;

    if (entry.pinned && before && before.body !== entry.body) return { ok: false, error: "pinned" };
    if (before) {
      const live = await transaction.select({ id: memoryEntries.id, title: memoryEntries.title, body: memoryEntries.body }).from(memoryEntries)
        .where(and(eq(memoryEntries.ownerId, ownerId), eq(memoryEntries.doc, entry.doc), eq(memoryEntries.status, "active"),
          entry.agentId ? eq(memoryEntries.agentId, entry.agentId) : sql`${memoryEntries.agentId} is null`));
      if (live.some((row) => row.id !== entry.id && row.title.toLowerCase() === before.title.toLowerCase())) {
        return { ok: false, error: "duplicate_title" };
      }
      const others = live.filter((row) => row.id !== entry.id).reduce((sum, row) => sum + row.title.length + row.body.length, 0);
      const cap = capFor(entry.doc as MemoryDocument);
      if (others + before.title.length + before.body.length > cap) return { ok: false, error: "over_cap" };
    }

    const after = before;
    const snapshotBefore = {
      title: entry.title, body: entry.body, pinned: entry.pinned, status: entry.status,
      scope: entry.scope, visibleTo: entry.visibleTo,
    };
    const nextStatus = before ? "active" : "archived";
    await transaction.update(memoryEntries).set({
      title: before?.title ?? entry.title, body: before?.body ?? entry.body,
      pinned: before?.pinned ?? entry.pinned, visibleTo: before?.visibleTo ?? entry.visibleTo,
      status: nextStatus, version: entry.version + 1, updatedAt: new Date(),
    }).where(and(eq(memoryEntries.ownerId, ownerId), eq(memoryEntries.id, entry.id)));

    const lastSeq = await transaction.select({ seq: memoryVersions.seq }).from(memoryVersions)
      .where(and(eq(memoryVersions.ownerId, ownerId), eq(memoryVersions.docKey, version.docKey)))
      .orderBy(desc(memoryVersions.seq)).limit(1);
    const newVersionId = randomUUID();
    await transaction.insert(memoryVersions).values({
      id: newVersionId, ownerId, docKey: version.docKey, seq: (lastSeq[0]?.seq ?? 0) + 1, entryId: entry.id,
      agentId: entry.agentId, op: "undo", before: snapshotBefore, after,
      author: "owner", authorAgentId: null, reason: "Undo", sourceRunId: null,
    });
    await recordAudit(transaction as unknown as AuditExecutor, ownerId, {
      kind: "memory_undone", agentId: entry.agentId, ref: entry.id,
    });
    return { ok: true, entryId: entry.id, versionId: newVersionId };
  });
  if (agentId) void scheduleMirror(database, ownerId, agentId).catch(() => undefined);
  return result;
}
