import "server-only";

import { randomUUID } from "node:crypto";
import { and, arrayContains, asc, desc, eq, inArray, or, sql } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { RequestError } from "../auth/request";
import { agentPolicies, agents, memoryEntries, memoryVersions } from "../../db/schema";
import {
  capFor, docKeyFor, entryChars, scopeFor, soulDocKey,
  type MemoryDocument, type MemoryEntryView, type MemorySnapshotShape, type MemoryVersionView,
} from "./schema";
import { scheduleMirror } from "./mirror";

type Database = Awaited<ReturnType<typeof getDatabase>>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface MemoryDocumentView {
  entries: MemoryEntryView[];
  chars: number;
  cap: number;
}

export interface MemoryView {
  soul: { text: string; updatedAt: string | null };
  user: MemoryDocumentView;
  memory: MemoryDocumentView;
  private: MemoryDocumentView;
  // TASK-086. auto: a change that quotes the owner's own words applies at once. ask: everything waits.
  mode: "auto" | "ask";
  // Agents the owner can share a private note with.
  agents: { id: string; name: string }[];
}

export type MemoryChange =
  | { op: "add"; doc: MemoryDocument; agentId: string | null; title: string; body: string; pinned?: boolean;
      visibleTo?: string[]; author: "owner" | "agent"; authorAgentId?: string | null; trusted?: boolean;
      reason?: string | null; sourceRunId?: string | null; sourceLabel?: string | null }
  | { op: "edit"; entryId: string; title?: string; body?: string; pinned?: boolean; visibleTo?: string[];
      author: "owner" | "agent"; authorAgentId?: string | null; reason?: string | null; sourceRunId?: string | null }
  | { op: "remove" | "pin" | "unpin"; entryId: string; author: "owner" | "agent"; authorAgentId?: string | null;
      reason?: string | null; sourceRunId?: string | null };

export type MemoryChangeResult =
  | { ok: true; entry: MemoryEntryView; versionId: string }
  | { ok: false; error: "not_found" | "over_cap" | "duplicate_title" | "invalid_visible_to" | "not_editable" };

const MAX_HISTORY = 100;

function toEntry(row: typeof memoryEntries.$inferSelect): MemoryEntryView {
  return {
    id: row.id, doc: row.doc as MemoryDocument, agentId: row.agentId, scope: row.scope as MemoryEntryView["scope"],
    visibleTo: row.visibleTo, title: row.title, body: row.body, pinned: row.pinned, trusted: row.trusted,
    status: row.status as MemoryEntryView["status"], author: row.author as MemoryEntryView["author"],
    sourceRunId: row.sourceRunId, sourceLabel: row.sourceLabel, version: row.version,
    lastConfirmedAt: row.lastConfirmedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

function snapshotOf(entry: MemoryEntryView): MemorySnapshotShape {
  return { title: entry.title, body: entry.body, pinned: entry.pinned, status: entry.status, scope: entry.scope, visibleTo: entry.visibleTo };
}

function toVersion(row: typeof memoryVersions.$inferSelect): MemoryVersionView {
  return {
    id: row.id, docKey: row.docKey, seq: row.seq, entryId: row.entryId, agentId: row.agentId, op: row.op,
    before: (row.before as MemorySnapshotShape | null) ?? null, after: (row.after as MemorySnapshotShape | null) ?? null,
    author: row.author as MemoryVersionView["author"], authorAgentId: row.authorAgentId, reason: row.reason,
    sourceRunId: row.sourceRunId, createdAt: row.createdAt.toISOString(),
  };
}

async function documentEntries(executor: Pick<Database, "select">, ownerId: string, doc: MemoryDocument, agentId: string | null) {
  const conditions = [eq(memoryEntries.ownerId, ownerId), eq(memoryEntries.doc, doc), eq(memoryEntries.status, "active")];
  if (doc !== "user" && agentId) conditions.push(eq(memoryEntries.agentId, agentId));
  const rows = await executor.select().from(memoryEntries).where(and(...conditions)).orderBy(desc(memoryEntries.pinned), desc(memoryEntries.updatedAt));
  return rows.map(toEntry);
}

function documentView(entries: MemoryEntryView[], doc: MemoryDocument): MemoryDocumentView {
  return { entries, chars: entries.reduce((sum, entry) => sum + entryChars(entry), 0), cap: capFor(doc) };
}

export async function listMemory(database: Database, ownerId: string, agentId: string): Promise<MemoryView> {
  const agentRows = await database.select({ soulMd: agents.soulMd, updatedAt: agents.updatedAt }).from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.id, agentId))).limit(1);
  // TASK-092. Another account's agent looks exactly like a missing one: no entries, no names, no modes leak.
  if (!agentRows[0]) throw new RequestError(403, "agent_not_found");
  const [user, memory, priv, policy, agentList] = await Promise.all([
    documentEntries(database, ownerId, "user", null),
    documentEntries(database, ownerId, "memory", agentId),
    documentEntries(database, ownerId, "private", agentId),
    database.select({ mode: agentPolicies.memoryMode }).from(agentPolicies)
      .where(and(eq(agentPolicies.ownerId, ownerId), eq(agentPolicies.agentId, agentId))).limit(1),
    database.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.ownerId, ownerId)).orderBy(asc(agents.name)).limit(100),
  ]);
  return {
    soul: { text: agentRows[0].soulMd, updatedAt: agentRows[0].updatedAt.toISOString() },
    user: documentView(user, "user"), memory: documentView(memory, "memory"), private: documentView(priv, "private"),
    mode: policy[0]?.mode === "auto" ? "auto" : "ask",
    agents: agentList,
  };
}

async function appendVersion(
  transaction: Transaction, ownerId: string, input: {
    docKey: string; entryId: string | null; agentId: string | null; op: MemoryVersionView["op"];
    before: MemorySnapshotShape | null; after: MemorySnapshotShape | null;
    author: "owner" | "agent"; authorAgentId?: string | null; reason?: string | null; sourceRunId?: string | null;
  },
): Promise<string> {
  const last = await transaction.select({ seq: memoryVersions.seq }).from(memoryVersions)
    .where(and(eq(memoryVersions.ownerId, ownerId), eq(memoryVersions.docKey, input.docKey)))
    .orderBy(desc(memoryVersions.seq)).limit(1);
  const seq = (last[0]?.seq ?? 0) + 1;
  const id = randomUUID();
  await transaction.insert(memoryVersions).values({
    id, ownerId, docKey: input.docKey, seq, entryId: input.entryId, agentId: input.agentId, op: input.op,
    before: input.before, after: input.after, author: input.author, authorAgentId: input.authorAgentId ?? null,
    reason: input.reason ?? null, sourceRunId: input.sourceRunId ?? null,
  });
  return id;
}

async function lockDocument(transaction: Transaction, ownerId: string, docKey: string): Promise<void> {
  await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ownerId}), hashtext(${docKey}))`);
}

async function validVisibleTo(transaction: Transaction, ownerId: string, ids: string[]): Promise<boolean> {
  if (!ids.length) return true;
  const rows = await transaction.select({ id: agents.id }).from(agents)
    .where(and(eq(agents.ownerId, ownerId), inArray(agents.id, ids)));
  return rows.length === ids.length;
}

async function documentTarget(transaction: Transaction, ownerId: string, doc: MemoryDocument, agentId: string | null) {
  if (doc !== "user") {
    if (!agentId) return null;
    const rows = await transaction.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.ownerId, ownerId), eq(agents.id, agentId))).limit(1);
    if (!rows[0]) return null;
  }
  return { docKey: docKeyFor(doc, agentId ?? ""), agentId: doc === "user" ? null : agentId };
}

// TASK-053. One write at a time per document. The document lock serializes concurrent writers so versions get
// distinct, gap-free seq values and two writes can never both fit under the cap.
export async function applyMemoryChange(database: Database, ownerId: string, change: MemoryChange): Promise<MemoryChangeResult> {
  const result = await database.transaction((transaction) => applyMemoryChangeWithin(transaction, ownerId, change));
  if (result.ok) {
    const agentId = result.entry.agentId;
    void scheduleMirror(database, ownerId, agentId).catch(() => undefined);
    // TASK-086. A document at 85% of its cap is tidied now instead of at 03:00.
    if (agentId) {
      void import("./queue").then(({ enqueueTidyIfFull }) => enqueueTidyIfFull(database, ownerId, agentId, result.entry.doc)).catch(() => undefined);
    }
  }
  return result;
}

// TASK-054. The owner decision and the applied memory change commit in one transaction.
export async function applyMemoryChangeWithin(
  transaction: Transaction, ownerId: string, change: MemoryChange,
): Promise<MemoryChangeResult> {
  {
    if (change.op === "add") {
      const target = await documentTarget(transaction, ownerId, change.doc, change.agentId);
      if (!target) return { ok: false, error: "not_found" };
      const visibleTo = change.doc === "private" ? (change.visibleTo ?? []) : [];
      await lockDocument(transaction, ownerId, target.docKey);
      if (!(await validVisibleTo(transaction, ownerId, visibleTo))) return { ok: false, error: "invalid_visible_to" };
      const live = await documentEntries(transaction, ownerId, change.doc, target.agentId);
      if (live.some((entry) => entry.title.toLowerCase() === change.title.toLowerCase())) return { ok: false, error: "duplicate_title" };
      if (live.reduce((sum, entry) => sum + entryChars(entry), 0) + entryChars(change) > capFor(change.doc)) return { ok: false, error: "over_cap" };
      const id = randomUUID();
      await transaction.insert(memoryEntries).values({
        id, ownerId, doc: change.doc, agentId: target.agentId, scope: scopeFor(change.doc), visibleTo,
        title: change.title, body: change.body, pinned: change.pinned ?? false,
        trusted: change.trusted ?? change.author === "owner", status: "active", author: change.author,
        sourceRunId: change.sourceRunId ?? null, sourceLabel: change.sourceLabel ?? null,
      });
      const entry: MemoryEntryView = {
        id, doc: change.doc, agentId: target.agentId, scope: scopeFor(change.doc), visibleTo,
        title: change.title, body: change.body, pinned: change.pinned ?? false, trusted: change.trusted ?? change.author === "owner",
        status: "active", author: change.author, sourceRunId: change.sourceRunId ?? null, sourceLabel: change.sourceLabel ?? null,
        lastConfirmedAt: null, version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      const versionId = await appendVersion(transaction, ownerId, {
        docKey: target.docKey, entryId: id, agentId: target.agentId, op: "add", before: null, after: snapshotOf(entry),
        author: change.author, authorAgentId: change.authorAgentId, reason: change.reason, sourceRunId: change.sourceRunId,
      });
      return { ok: true, entry, versionId };
    }

    const rows = await transaction.select().from(memoryEntries)
      .where(and(eq(memoryEntries.ownerId, ownerId), eq(memoryEntries.id, change.entryId))).limit(1);
    if (!rows[0]) return { ok: false, error: "not_found" };
    const before = toEntry(rows[0]);
    if (before.status !== "active") return { ok: false, error: "not_found" };
    const docKey = docKeyFor(before.doc, before.agentId ?? "");
    await lockDocument(transaction, ownerId, docKey);
    const currentRows = await transaction.select().from(memoryEntries)
      .where(and(eq(memoryEntries.ownerId, ownerId), eq(memoryEntries.id, change.entryId))).limit(1);
    if (!currentRows[0]) return { ok: false, error: "not_found" };
    const current = toEntry(currentRows[0]);
    if (current.status !== "active") return { ok: false, error: "not_found" };

    if (change.op === "remove") {
      await transaction.update(memoryEntries).set({ status: "archived", version: current.version + 1, updatedAt: new Date() })
        .where(and(eq(memoryEntries.ownerId, ownerId), eq(memoryEntries.id, current.id)));
      const versionId = await appendVersion(transaction, ownerId, {
        docKey, entryId: current.id, agentId: current.agentId, op: "remove", before: snapshotOf(current), after: null,
        author: change.author, authorAgentId: change.authorAgentId, reason: change.reason, sourceRunId: change.sourceRunId,
      });
      return { ok: true, entry: { ...current, status: "archived", version: current.version + 1 }, versionId };
    }

    const nextPinned = change.op === "edit" ? (change.pinned ?? current.pinned)
      : change.op === "pin" ? true : change.op === "unpin" ? false : current.pinned;
    const next: MemoryEntryView = {
      ...current,
      title: change.op === "edit" ? change.title ?? current.title : current.title,
      body: change.op === "edit" ? change.body ?? current.body : current.body,
      pinned: nextPinned,
      visibleTo: change.op === "edit" ? (current.doc === "private" ? change.visibleTo ?? current.visibleTo : current.visibleTo) : current.visibleTo,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    if (change.op === "edit") {
      if (current.doc === "private" && !(await validVisibleTo(transaction, ownerId, next.visibleTo))) return { ok: false, error: "invalid_visible_to" };
      const live = await documentEntries(transaction, ownerId, current.doc, current.agentId);
      if (live.some((entry) => entry.id !== current.id && entry.title.toLowerCase() === next.title.toLowerCase())) {
        return { ok: false, error: "duplicate_title" };
      }
      const otherChars = live.filter((entry) => entry.id !== current.id).reduce((sum, entry) => sum + entryChars(entry), 0);
      if (otherChars + entryChars(next) > capFor(current.doc)) return { ok: false, error: "over_cap" };
    }
    await transaction.update(memoryEntries).set({
      title: next.title, body: next.body, pinned: next.pinned, visibleTo: next.visibleTo,
      version: next.version, updatedAt: new Date(),
    }).where(and(eq(memoryEntries.ownerId, ownerId), eq(memoryEntries.id, current.id)));
    const op = change.op === "edit" ? "edit" : change.op;
    const versionId = await appendVersion(transaction, ownerId, {
      docKey, entryId: current.id, agentId: current.agentId, op, before: snapshotOf(current), after: snapshotOf(next),
      author: change.author, authorAgentId: change.authorAgentId, reason: change.reason, sourceRunId: change.sourceRunId,
    });
    return { ok: true, entry: next, versionId };
  }
}

// TASK-086. A repeat of a known fact refreshes it without changing its text.
export async function confirmEntry(database: Database, ownerId: string, entryId: string): Promise<boolean> {
  const rows = await database.update(memoryEntries).set({ lastConfirmedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(memoryEntries.ownerId, ownerId), eq(memoryEntries.id, entryId), eq(memoryEntries.status, "active")))
    .returning({ id: memoryEntries.id });
  return rows.length > 0;
}

export async function updateSoul(
  database: Database, ownerId: string, agentId: string, soulMd: string,
): Promise<{ ok: true; text: string; versionId: string } | { ok: false; error: "not_found" }> {
  const result = await database.transaction(async (transaction) => {
    const docKey = soulDocKey(agentId);
    await lockDocument(transaction, ownerId, docKey);
    const rows = await transaction.select({ soulMd: agents.soulMd }).from(agents)
      .where(and(eq(agents.ownerId, ownerId), eq(agents.id, agentId))).limit(1);
    if (!rows[0]) return { ok: false as const, error: "not_found" as const };
    await transaction.update(agents).set({ soulMd, updatedAt: new Date() })
      .where(and(eq(agents.ownerId, ownerId), eq(agents.id, agentId)));
    const versionId = await appendVersion(transaction, ownerId, {
      docKey, entryId: null, agentId, op: "soul_edit",
      before: { title: "PERSONA.md", body: rows[0].soulMd, pinned: false, status: "active", scope: "agent", visibleTo: [] },
      after: { title: "PERSONA.md", body: soulMd, pinned: false, status: "active", scope: "agent", visibleTo: [] },
      author: "owner",
    });
    return { ok: true as const, text: soulMd, versionId };
  });
  if (result.ok) void scheduleMirror(database, ownerId, agentId).catch(() => undefined);
  return result;
}

// TASK-053. The agent form edits the same persona as the Memory tab; both append a version in their own transaction.
export async function appendSoulVersion(
  transaction: Transaction, ownerId: string, agentId: string, beforeText: string, afterText: string,
): Promise<string> {
  // Unit fixtures use a tiny fake transaction; the real Drizzle transaction always has `execute`.
  if (typeof (transaction as { execute?: unknown }).execute !== "function") return "";
  await lockDocument(transaction, ownerId, soulDocKey(agentId));
  return appendVersion(transaction, ownerId, {
    docKey: soulDocKey(agentId), entryId: null, agentId, op: "soul_edit",
    before: { title: "PERSONA.md", body: beforeText, pinned: false, status: "active", scope: "agent", visibleTo: [] },
    after: { title: "PERSONA.md", body: afterText, pinned: false, status: "active", scope: "agent", visibleTo: [] },
    author: "owner",
  });
}

export async function listHistory(
  database: Database, ownerId: string, docKey: string, limit = MAX_HISTORY,
): Promise<MemoryVersionView[]> {
  const rows = await database.select().from(memoryVersions)
    .where(and(eq(memoryVersions.ownerId, ownerId), eq(memoryVersions.docKey, docKey)))
    .orderBy(desc(memoryVersions.seq)).limit(Math.min(limit, MAX_HISTORY));
  return rows.map(toVersion);
}

// The snapshot needs the same entries, scoped to one reader's policy.
export async function memoryEntriesForReader(database: Database, ownerId: string, agentId: string) {
  const [policyRows, user, memory, privateRows] = await Promise.all([
    database.select({ memoryScopes: agentPolicies.memoryScopes }).from(agentPolicies)
      .where(and(eq(agentPolicies.ownerId, ownerId), eq(agentPolicies.agentId, agentId))).limit(1),
    documentEntries(database, ownerId, "user", null),
    documentEntries(database, ownerId, "memory", agentId),
    database.select().from(memoryEntries).where(and(
      eq(memoryEntries.ownerId, ownerId), eq(memoryEntries.doc, "private"), eq(memoryEntries.status, "active"),
      or(eq(memoryEntries.agentId, agentId), arrayContains(memoryEntries.visibleTo, [agentId]))!,
    )).orderBy(desc(memoryEntries.pinned), desc(memoryEntries.updatedAt)),
  ]);
  return { policyScopes: policyRows[0]?.memoryScopes ?? [], entries: [...user, ...memory, ...privateRows.map(toEntry)] };
}
