import "server-only";

import { and, count, eq, gt } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { approvals, memoryChanges } from "../../db/schema";
import { clearAgentAttention, setApprovalAttention } from "../costs/store";

type Database = Awaited<ReturnType<typeof getDatabase>>;

export const MEMORY_CHANGE_TTL_MS = 14 * 24 * 60 * 60_000;

// TASK-050/054. "Needs you" while either a risky-action approval or a memory change is waiting. One helper decides it so
// clearing one kind never clears the other's pending state.
export async function refreshApprovalAttention(database: Database, ownerId: string, agentId: string): Promise<void> {
  const [approvalRows, changeRows] = await Promise.all([
    database.select({ count: count() }).from(approvals)
      .where(and(eq(approvals.ownerId, ownerId), eq(approvals.agentId, agentId), eq(approvals.state, "pending"))),
    database.select({ count: count() }).from(memoryChanges)
      .where(and(
        eq(memoryChanges.ownerId, ownerId), eq(memoryChanges.agentId, agentId), eq(memoryChanges.state, "pending"),
        gt(memoryChanges.createdAt, new Date(Date.now() - MEMORY_CHANGE_TTL_MS)),
      )),
  ]);
  const pending = Number(approvalRows[0]?.count ?? 0) + Number(changeRows[0]?.count ?? 0);
  if (pending > 0) await setApprovalAttention(database, ownerId, agentId);
  else await clearAgentAttention(database, ownerId, agentId, "approval_pending");
}

export function expiredChange(createdAt: Date): boolean {
  return Date.now() - createdAt.getTime() > MEMORY_CHANGE_TTL_MS;
}
