import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { auditLog } from "../../db/schema";
import { buildAuditEntry, buildAuditExport, genesisHash, signAuditEntry, verifyAuditExport, type AuditExport } from "./audit-chain.mjs";
import type { ReceiptSigner } from "../receipts/signer";
import { loadReceiptSigner } from "../receipts/signer";

type Database = Awaited<ReturnType<typeof getDatabase>>;
type Executor = Pick<Database, "select" | "insert" | "execute">;

export const SECURITY_AUDIT_KINDS = [
  "tripwire", "scope_blocked", "egress_blocked", "approval_denied", "agent_stopped", "crew_stopped", "crew_resumed",
] as const;
export const ADMIN_AUDIT_KINDS = [
  "login", "password_changed", "email_changed", "sessions_revoked", "agent_created", "agent_updated",
  "agent_paused", "agent_resumed", "agent_deleted", "astra_enabled", "astra_disabled", "approval_allowed",
  "permission_revoked", "memory_approved", "memory_rejected", "memory_undone",
  "connection_added", "connection_replaced", "connection_removed",
  "composio_key_saved", "composio_key_removed", "composio_account_connected", "composio_account_revoked",
] as const;
export type AuditKind = (typeof SECURITY_AUDIT_KINDS)[number] | (typeof ADMIN_AUDIT_KINDS)[number];

export type AuditExecutor = Executor;

export interface AuditInput {
  kind: AuditKind;
  agentId?: string | null;
  runId?: string | null;
  ref?: string | null;
  code?: string | null;
  host?: string | null;
  sourceRef?: string | null;
  ts?: Date;
}

export interface AuditFilter {
  agent?: string;
  group?: "security" | "admin";
  range?: "24h" | "7d" | "30d" | "all";
  before?: number;
  limit?: number;
}

export interface AuditRowView {
  id: string;
  seq: number;
  kind: AuditKind;
  agentId: string | null;
  runId: string | null;
  ref: string | null;
  code: string | null;
  host: string | null;
  createdAt: string;
}

export interface AuditStatus {
  signing: boolean;
  verified: boolean;
  reason: string | null;
  entries: number;
  headSeq: number;
  headHash: string | null;
}

function auditSigner(): ReceiptSigner | null {
  try { return loadReceiptSigner(); } catch { return null; }
}

export function auditSigningAvailable(): boolean {
  return auditSigner() !== null;
}

// One entry per change, appended under a per-owner advisory lock so seq has no gaps or duplicates. Called as the last
// statement of the caller's transaction; a missing signing key skips the row and never fails the caller's change.
export async function recordAudit(executor: Executor, ownerId: string, input: AuditInput): Promise<boolean> {
  const signer = auditSigner();
  if (!signer) return false;
  await executor.execute(sqlAdvisoryLock(ownerId));
  if (input.sourceRef) {
    const existing = await executor.select({ id: auditLog.id }).from(auditLog)
      .where(and(eq(auditLog.ownerId, ownerId), eq(auditLog.sourceRef, input.sourceRef))).limit(1);
    if (existing[0]) return false;
  }
  const last = await executor.select({ seq: auditLog.seq, entryHash: auditLog.entryHash }).from(auditLog)
    .where(eq(auditLog.ownerId, ownerId)).orderBy(desc(auditLog.seq)).limit(1);
  const seq = (last[0]?.seq ?? 0) + 1;
  const prevHash = last[0]?.entryHash ?? genesisHash(ownerId);
  const entry = buildAuditEntry({
    seq, kind: input.kind, agentId: input.agentId ?? null, runId: input.runId ?? null,
    ref: input.ref ?? null, code: input.code ?? null, host: input.host ?? null,
    ts: (input.ts ?? new Date()).toISOString(), prevHash,
  });
  await executor.insert(auditLog).values({
    id: randomUUID(), ownerId, seq, kind: input.kind, agentId: input.agentId ?? null, runId: input.runId ?? null,
    ref: input.ref ?? null, code: input.code ?? null, host: input.host ?? null, sourceRef: input.sourceRef ?? null,
    entryJson: entry.text, entryHash: entry.hash, prevHash, signature: signAuditEntry(signer.privateKey, entry.hash),
    keyId: signer.keyId,
  });
  return true;
}

function sqlAdvisoryLock(ownerId: string): SQL {
  return sql`SELECT pg_advisory_xact_lock(hashtext(${ownerId}), hashtext('audit'))`;
}

// Kill switches and other paths that cannot hold a transaction: the stop happens first, then the log is best effort.
export async function recordAuditBestEffort(database: Database, ownerId: string, input: AuditInput): Promise<boolean> {
  try {
    return await database.transaction((transaction) => recordAudit(transaction as unknown as Executor, ownerId, input));
  } catch {
    return false;
  }
}

function rangeStart(range: AuditFilter["range"]): Date | null {
  if (!range || range === "all") return null;
  const hours = range === "24h" ? 24 : range === "7d" ? 24 * 7 : 24 * 30;
  return new Date(Date.now() - hours * 60 * 60_000);
}

export async function listAudit(database: Database, ownerId: string, filter: AuditFilter): Promise<{ entries: AuditRowView[]; hasMore: boolean }> {
  const conditions: SQL[] = [eq(auditLog.ownerId, ownerId)];
  if (filter.agent) conditions.push(eq(auditLog.agentId, filter.agent));
  if (filter.group === "security") conditions.push(inArray(auditLog.kind, [...SECURITY_AUDIT_KINDS]));
  if (filter.group === "admin") conditions.push(inArray(auditLog.kind, [...ADMIN_AUDIT_KINDS]));
  const start = rangeStart(filter.range);
  if (start) conditions.push(gte(auditLog.createdAt, start));
  if (filter.before !== undefined) conditions.push(lt(auditLog.seq, filter.before));
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 100);
  const rows = await database.select({
    id: auditLog.id, seq: auditLog.seq, kind: auditLog.kind, agentId: auditLog.agentId, runId: auditLog.runId,
    ref: auditLog.ref, code: auditLog.code, host: auditLog.host, createdAt: auditLog.createdAt,
  }).from(auditLog).where(and(...conditions)).orderBy(desc(auditLog.seq)).limit(limit + 1);
  return {
    entries: rows.slice(0, limit).map((row) => ({
      id: row.id, seq: Number(row.seq), kind: row.kind as AuditKind, agentId: row.agentId, runId: row.runId,
      ref: row.ref, code: row.code, host: row.host, createdAt: row.createdAt.toISOString(),
    })),
    hasMore: rows.length > limit,
  };
}

export async function loadAuditExport(database: Database, ownerId: string): Promise<AuditExport> {
  const signer = auditSigner();
  if (!signer) throw new Error("audit_signing_unavailable");
  const rows = await database.select({
    seq: auditLog.seq, entryJson: auditLog.entryJson, entryHash: auditLog.entryHash,
    prevHash: auditLog.prevHash, signature: auditLog.signature,
  }).from(auditLog).where(eq(auditLog.ownerId, ownerId)).orderBy(asc(auditLog.seq));
  return buildAuditExport({
    ownerId, keyId: signer.keyId, publicKey: signer.publicKey, exportedAt: new Date().toISOString(),
    entries: rows.map((row) => ({
      seq: Number(row.seq), entryText: row.entryJson, entryHash: row.entryHash, prevHash: row.prevHash, signature: row.signature,
    })),
  });
}

// The Security Center shows proof, not a claim: the same verifier the CLI uses checks the owner's whole chain.
export async function auditStatus(database: Database, ownerId: string): Promise<AuditStatus> {
  if (!auditSigner()) return { signing: false, verified: false, reason: "signing_unavailable", entries: 0, headSeq: 0, headHash: null };
  try {
    const exported = await loadAuditExport(database, ownerId);
    const result = verifyAuditExport(exported);
    return result.ok
      ? { signing: true, verified: true, reason: null, entries: result.entries, headSeq: result.headSeq, headHash: result.headHash }
      : { signing: true, verified: false, reason: result.reason, entries: exported.entries.length, headSeq: exported.entries.at(-1)?.seq ?? 0, headHash: null };
  } catch {
    return { signing: true, verified: false, reason: "unreadable", entries: 0, headSeq: 0, headHash: null };
  }
}
