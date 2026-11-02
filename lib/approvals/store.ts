import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { approvals, permissionUses, permissions } from "../../db/schema";
import type { ActionClass } from "../agent/risk";
import { cleanText } from "../receipts/chain.mjs";
import { recordAudit, type AuditExecutor } from "../security/audit";
import type { ApprovalDecision, ApprovalState, ApprovalView } from "./types";

type Database = Awaited<ReturnType<typeof getDatabase>>;

export interface ApprovalRow {
  id: string;
  ownerId: string;
  agentId: string;
  runId: string | null;
  actionClass: string;
  site: string;
  controlName: string;
  state: string;
  decidedAt: Date | null;
  createdAt: Date;
}

export interface GrantRow {
  id: string;
  ownerId: string;
  agentId: string;
  site: string;
  actionClass: string;
  maxPerDay: number;
  createdAt: Date;
  revokedAt: Date | null;
}

const DECIDED_STATE: Record<ApprovalDecision, ApprovalState> = {
  allow_once: "allowed_once",
  always_allow: "always_allowed",
  deny: "denied",
};

export type DecideResult =
  | { ok: true; approval: ApprovalRow }
  | { ok: false; error: "not_found" | "already_decided" | "expired" | "site_unknown" };

function toView(row: ApprovalRow): ApprovalView {
  return {
    id: row.id,
    state: row.state as ApprovalState,
    actionClass: row.actionClass as ActionClass,
    site: row.site,
    controlName: row.controlName,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    canAlwaysAllow: row.site.length > 0,
  };
}

export function approvalView(row: ApprovalRow): ApprovalView {
  return toView(row);
}

export async function createApproval(
  database: Database,
  input: {
    ownerId: string; agentId: string; runId: string | null; actionClass: ActionClass; site: string | null; controlName: string;
    // TASK-051. Astra records the request as auto-allowed instead of waiting for the owner.
    state?: "pending" | "auto_allowed";
  },
): Promise<string> {
  const id = randomUUID();
  await database.insert(approvals).values({
    id,
    ownerId: input.ownerId,
    agentId: input.agentId,
    runId: input.runId,
    actionClass: input.actionClass,
    site: cleanText(input.site ?? "", 255),
    controlName: cleanText(input.controlName, 120) || "this action",
    state: input.state ?? "pending",
    ...(input.state === "auto_allowed" ? { decidedAt: new Date() } : {}),
  });
  return id;
}

export async function getApproval(database: Database, ownerId: string, id: string): Promise<ApprovalRow | null> {
  const rows = await database.select().from(approvals)
    .where(and(eq(approvals.ownerId, ownerId), eq(approvals.id, id))).limit(1);
  return rows[0] ?? null;
}

export async function markApprovalStale(database: Database, ownerId: string, id: string): Promise<boolean> {
  const updated = await database.update(approvals).set({ state: "stale" })
    .where(and(
      eq(approvals.ownerId, ownerId), eq(approvals.id, id),
      sql`${approvals.state} in ('allowed_once', 'always_allowed')`,
    )).returning({ id: approvals.id });
  return Boolean(updated[0]);
}

export async function expireApproval(database: Database, ownerId: string, id: string): Promise<boolean> {
  const updated = await database.update(approvals).set({ state: "expired", decidedAt: new Date() })
    .where(and(eq(approvals.ownerId, ownerId), eq(approvals.id, id), eq(approvals.state, "pending")))
    .returning({ id: approvals.id });
  return Boolean(updated[0]);
}

// One transition out of `pending`. A second decision loses the race and reads the winning state.
export async function decideApproval(
  database: Database, ownerId: string, id: string, decision: ApprovalDecision,
): Promise<DecideResult> {
  return database.transaction(async (transaction) => {
    const current = await getApproval(transaction as unknown as Database, ownerId, id);
    if (!current) return { ok: false, error: "not_found" };
    if (current.state === "expired") return { ok: false, error: "expired" };
    if (current.state !== "pending") return { ok: false, error: "already_decided" };
    if (decision === "always_allow" && current.site.length === 0) return { ok: false, error: "site_unknown" };

    const updated = await transaction.update(approvals).set({ state: DECIDED_STATE[decision], decidedAt: new Date() })
      .where(and(eq(approvals.ownerId, ownerId), eq(approvals.id, id), eq(approvals.state, "pending")))
      .returning();
    const row = updated[0];
    if (!row) {
      const after = await getApproval(transaction as unknown as Database, ownerId, id);
      if (!after) return { ok: false, error: "not_found" };
      return { ok: false, error: after.state === "expired" ? "expired" : "already_decided" };
    }

    if (decision === "always_allow") {
      await createGrant(transaction as unknown as Database, {
        ownerId, agentId: row.agentId, site: row.site, actionClass: row.actionClass as ActionClass,
      });
    }
    await recordAudit(transaction as unknown as AuditExecutor, ownerId, {
      kind: decision === "deny" ? "approval_denied" : "approval_allowed",
      agentId: row.agentId, runId: row.runId, code: decision,
    });
    return { ok: true, approval: row as ApprovalRow };
  });
}

export async function findGrant(
  database: Database, ownerId: string, agentId: string, site: string, actionClass: string,
): Promise<GrantRow | null> {
  const rows = await database.select().from(permissions).where(and(
    eq(permissions.ownerId, ownerId),
    eq(permissions.agentId, agentId),
    eq(permissions.site, site),
    eq(permissions.actionClass, actionClass),
    isNull(permissions.revokedAt),
  )).limit(1);
  return (rows[0] as GrantRow | undefined) ?? null;
}

export async function countUses(database: Database, ownerId: string, permissionId: string, since: Date): Promise<number> {
  const rows = await database.select({ count: sql<string>`count(*)` }).from(permissionUses)
    .where(and(
      eq(permissionUses.ownerId, ownerId),
      eq(permissionUses.permissionId, permissionId),
      gte(permissionUses.usedAt, since),
    ));
  return Number(rows[0]?.count ?? 0);
}

export async function recordUse(
  database: Database, ownerId: string, permissionId: string, runId: string | null,
): Promise<void> {
  await database.insert(permissionUses).values({ id: randomUUID(), ownerId, permissionId, runId });
}

export async function createGrant(
  database: Database,
  input: { ownerId: string; agentId: string; site: string; actionClass: ActionClass; maxPerDay?: number },
): Promise<string> {
  const existing = await findGrant(database, input.ownerId, input.agentId, input.site, input.actionClass);
  if (existing) return existing.id;
  const id = randomUUID();
  await database.insert(permissions).values({
    id, ownerId: input.ownerId, agentId: input.agentId, site: input.site, actionClass: input.actionClass,
    maxPerDay: input.maxPerDay ?? 20,
  }).onConflictDoNothing();
  const created = await findGrant(database, input.ownerId, input.agentId, input.site, input.actionClass);
  return created?.id ?? id;
}

export async function revokeGrant(database: Database, ownerId: string, permissionId: string): Promise<boolean> {
  return database.transaction(async (transaction) => {
    const updated = await transaction.update(permissions).set({ revokedAt: new Date() })
      .where(and(eq(permissions.ownerId, ownerId), eq(permissions.id, permissionId), isNull(permissions.revokedAt)))
      .returning({ id: permissions.id, agentId: permissions.agentId });
    if (!updated[0]) return false;
    await recordAudit(transaction as unknown as AuditExecutor, ownerId, {
      kind: "permission_revoked", agentId: updated[0].agentId, ref: updated[0].id,
    });
    return true;
  });
}

export async function listGrants(database: Database, ownerId: string, agentId: string): Promise<GrantRow[]> {
  return database.select().from(permissions).where(and(
    eq(permissions.ownerId, ownerId), eq(permissions.agentId, agentId), isNull(permissions.revokedAt),
  )).orderBy(desc(permissions.createdAt)) as Promise<GrantRow[]>;
}
