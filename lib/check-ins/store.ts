import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, count, eq } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { agents, checkIns, owner } from "../../db/schema";
import { RequestError } from "../auth/request";
import { resolveTimezone } from "../time/clock";
import { MAX_CHECK_INS_PER_AGENT, planNextCheck, type CheckInInput, type CheckInKind, type CheckInStatus, type CheckInVia } from "./logic";

type Database = Awaited<ReturnType<typeof getDatabase>>;
export type CheckInRow = typeof checkIns.$inferSelect;

// What the browser sees. The fingerprint and page snapshot stay server-side.
export type CheckInView = {
  id: string; name: string; kind: CheckInKind; url: string; via: CheckInVia; goal: string | null; urgent: boolean;
  intervalMinutes: number; windowStart: number; windowEnd: number; timezone: string; active: boolean;
  lastStatus: CheckInStatus | null; lastCheckedAt: string | null; lastChangedAt: string | null; nextCheckAt: string;
  pendingChanges: number;
};

export function toCheckInView(row: CheckInRow): CheckInView {
  return {
    id: row.id, name: row.name, kind: row.kind as CheckInKind, url: row.url, via: row.via as CheckInVia, goal: row.goal, urgent: row.urgent,
    intervalMinutes: row.intervalMinutes, windowStart: row.windowStart, windowEnd: row.windowEnd, timezone: row.timezone,
    active: row.active, lastStatus: (row.lastStatus ?? null) as CheckInStatus | null,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null, lastChangedAt: row.lastChangedAt?.toISOString() ?? null,
    nextCheckAt: row.nextCheckAt.toISOString(), pendingChanges: row.pendingChanges,
  };
}

async function requireOwnedAgent(database: Database, ownerId: string, agentId: string) {
  const [row] = await database.select({ id: agents.id }).from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.id, agentId))).limit(1);
  if (!row) throw new RequestError(404, "agent_not_found");
}

export async function listCheckIns(database: Database, ownerId: string, agentId: string): Promise<CheckInView[]> {
  await requireOwnedAgent(database, ownerId, agentId);
  const rows = await database.select().from(checkIns)
    .where(and(eq(checkIns.ownerId, ownerId), eq(checkIns.agentId, agentId)))
    .orderBy(asc(checkIns.createdAt)).limit(MAX_CHECK_INS_PER_AGENT);
  return rows.map(toCheckInView);
}

export async function createCheckIn(database: Database, ownerId: string, agentId: string, input: CheckInInput, now = new Date()): Promise<CheckInView> {
  await requireOwnedAgent(database, ownerId, agentId);
  const [{ total }] = await database.select({ total: count() }).from(checkIns)
    .where(and(eq(checkIns.ownerId, ownerId), eq(checkIns.agentId, agentId)));
  if (total >= MAX_CHECK_INS_PER_AGENT) throw new RequestError(409, "check_in_limit");
  const [ownerRow] = await database.select({ timezone: owner.timezone }).from(owner).where(eq(owner.id, ownerId)).limit(1);
  const timezone = resolveTimezone(ownerRow?.timezone) ?? "UTC";
  // The first probe runs on the next tick when the window is open, so the owner sees a baseline right away.
  const firstCheck = planNextCheck({ now, timeZone: timezone, windowStart: input.windowStart, windowEnd: input.windowEnd, intervalMinutes: 5, quietStreak: 0, random: 0 });
  const opensNow = firstCheck.getTime() - now.getTime() <= 5 * 60_000;
  const [row] = await database.insert(checkIns).values({
    id: randomUUID(), ownerId, agentId, name: input.name, kind: input.kind, url: input.url, via: input.via, goal: input.goal,
    urgent: input.urgent, intervalMinutes: input.intervalMinutes, windowStart: input.windowStart, windowEnd: input.windowEnd,
    timezone, nextCheckAt: opensNow ? now : firstCheck, createdAt: now, updatedAt: now,
  }).returning();
  return toCheckInView(row);
}

export async function setCheckInActive(database: Database, ownerId: string, agentId: string, id: string, active: boolean, now = new Date()): Promise<CheckInView> {
  const [row] = await database.update(checkIns).set({
    active, updatedAt: now, ...(active ? { nextCheckAt: now, quietStreak: 0 } : {}),
  }).where(and(eq(checkIns.ownerId, ownerId), eq(checkIns.agentId, agentId), eq(checkIns.id, id))).returning();
  if (!row) throw new RequestError(404, "check_in_not_found");
  return toCheckInView(row);
}

export async function deleteCheckIn(database: Database, ownerId: string, agentId: string, id: string): Promise<void> {
  const rows = await database.delete(checkIns)
    .where(and(eq(checkIns.ownerId, ownerId), eq(checkIns.agentId, agentId), eq(checkIns.id, id))).returning({ id: checkIns.id });
  if (!rows[0]) throw new RequestError(404, "check_in_not_found");
}

export async function getCheckIn(database: Database, ownerId: string, agentId: string, id: string): Promise<CheckInRow | null> {
  const [row] = await database.select().from(checkIns)
    .where(and(eq(checkIns.ownerId, ownerId), eq(checkIns.agentId, agentId), eq(checkIns.id, id))).limit(1);
  return row ?? null;
}
