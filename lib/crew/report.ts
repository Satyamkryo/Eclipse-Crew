import "server-only";

import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { agents, approvals, chatSessions, costEntries, crewReportDeliveries, crewReportSettings, messages, owner, runMeta, runs, steps } from "../../db/schema";
import { chatCardSchema, type ChatCard } from "../chat/schema";
import { outcomeOf, readRunHeader } from "../jobs/view";
import { RequestError } from "../auth/request";
import { mostRecentLocalTime, parseLocalTime, reportWindow } from "./time";

type Database = Awaited<ReturnType<typeof getDatabase>>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type CrewReportCard = Extract<ChatCard, { type: "crew_report" }>;

export interface ReportSettingsView {
  enabled: boolean;
  recipientAgentId: string | null;
  recipientName: string | null;
  recipientStatus: "active" | "paused" | null;
  localTime: string;
  timezone: string;
  updatedAt: string | null;
  lastDelivery: { scheduledAt: string; messageId: string | null; state: "delivered" | "skipped" } | null;
}

export interface ReportDeliveryResult {
  status: "delivered" | "duplicate" | "skipped";
  messageId: string | null;
  scheduledAt: string;
  windowStart: string;
  windowEnd: string;
  card: CrewReportCard | null;
  code?: "recipient_unavailable";
}

async function ownerTimezone(database: Database, ownerId: string): Promise<string> {
  const rows = await database.select({ timezone: owner.timezone }).from(owner).where(eq(owner.id, ownerId)).limit(1);
  return rows[0]?.timezone ?? "UTC";
}

export async function loadReportSettings(database: Database, ownerId: string): Promise<ReportSettingsView> {
  const timezone = await ownerTimezone(database, ownerId);
  const rows = await database.select({
    enabled: crewReportSettings.enabled,
    recipientAgentId: crewReportSettings.recipientAgentId,
    localTime: crewReportSettings.localTime,
    updatedAt: crewReportSettings.updatedAt,
    recipientName: agents.name,
    recipientStatus: agents.status,
  }).from(crewReportSettings)
    .leftJoin(agents, and(eq(agents.id, crewReportSettings.recipientAgentId), eq(agents.ownerId, ownerId)))
    .where(eq(crewReportSettings.ownerId, ownerId)).limit(1);
  const row = rows[0];
  const deliveryRows = await database.select({
    scheduledAt: crewReportDeliveries.scheduledAt,
    messageId: crewReportDeliveries.messageId,
  }).from(crewReportDeliveries).where(eq(crewReportDeliveries.ownerId, ownerId))
    .orderBy(desc(crewReportDeliveries.scheduledAt)).limit(1);
  const delivery = deliveryRows[0];
  return {
    enabled: row?.enabled ?? false,
    recipientAgentId: row?.recipientAgentId ?? null,
    recipientName: row?.recipientName ?? null,
    recipientStatus: row?.recipientStatus === "active" || row?.recipientStatus === "paused" ? row.recipientStatus : null,
    localTime: row?.localTime ?? "09:00",
    timezone,
    updatedAt: row?.updatedAt.toISOString() ?? null,
    lastDelivery: delivery
      ? { scheduledAt: delivery.scheduledAt.toISOString(), messageId: delivery.messageId, state: delivery.messageId ? "delivered" : "skipped" }
      : null,
  };
}

// The recipient must belong to this owner. Paused is allowed here so the owner can fix it; delivery rechecks status.
export async function saveReportSettings(
  database: Database, ownerId: string,
  input: { enabled: boolean; recipientAgentId: string | null; localTime: string },
): Promise<ReportSettingsView> {
  if (input.enabled && !input.recipientAgentId) throw new RequestError(400, "recipient_required");
  if (input.recipientAgentId) {
    const rows = await database.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.ownerId, ownerId), eq(agents.id, input.recipientAgentId))).limit(1);
    if (!rows[0]) throw new RequestError(400, "recipient_not_owned");
  }
  const now = new Date();
  await database.insert(crewReportSettings).values({
    ownerId,
    enabled: input.enabled,
    recipientAgentId: input.recipientAgentId,
    localTime: input.localTime,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: crewReportSettings.ownerId,
    set: { enabled: input.enabled, recipientAgentId: input.recipientAgentId, localTime: input.localTime, updatedAt: now },
  });
  return loadReportSettings(database, ownerId);
}

async function recipient(database: Database, ownerId: string, agentId: string) {
  const rows = await database.select({ id: agents.id, name: agents.name, status: agents.status }).from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.id, agentId))).limit(1);
  return rows[0];
}

// Every count and cost is read from stored rows in [windowStart, windowEnd). "Verified" never comes from an assumption.
export async function buildCrewReport(
  database: Database, ownerId: string, scheduledAt: Date, timezone: string,
): Promise<CrewReportCard> {
  const { windowStart, windowEnd } = reportWindow(scheduledAt);
  const runRows = await database.select({
    id: runs.id,
    agentId: runs.agentId,
    headerJson: runs.headerJson,
    startedAt: runs.startedAt,
    endedAt: runs.endedAt,
    status: runs.status,
    signature: runs.signature,
    heartbeatAt: runs.heartbeatAt,
    label: runMeta.label,
  }).from(runs)
    .leftJoin(runMeta, and(eq(runMeta.runId, runs.id), eq(runMeta.ownerId, ownerId)))
    .where(and(eq(runs.ownerId, ownerId), gte(runs.startedAt, windowStart), lt(runs.startedAt, windowEnd)))
    .orderBy(desc(runs.startedAt), desc(runs.id));

  const ids = runRows.map((row) => row.id);
  const [stepRows, costRows, approvalRows] = await Promise.all([
    ids.length === 0 ? [] : database.select({ runId: steps.runId, receiptJson: steps.receiptJson }).from(steps)
      .where(and(eq(steps.ownerId, ownerId), inArray(steps.runId, ids))).orderBy(steps.idx),
    database.select({ cost: sql<number>`coalesce(sum(${costEntries.costMicroUsd}), 0)::bigint` }).from(costEntries)
      .where(and(eq(costEntries.ownerId, ownerId), gte(costEntries.createdAt, windowStart), lt(costEntries.createdAt, windowEnd))),
    ids.length === 0 ? [] : database.select({ runId: approvals.runId }).from(approvals)
      .where(and(eq(approvals.ownerId, ownerId), eq(approvals.state, "pending"), inArray(approvals.runId, ids))),
  ]);

  const resultsByRun = new Map<string, string[]>();
  for (const row of stepRows) {
    let result = "unknown";
    try { const parsed = JSON.parse(row.receiptJson) as { result?: unknown }; if (typeof parsed.result === "string") result = parsed.result; } catch { /* unknown */ }
    resultsByRun.set(row.runId, [...(resultsByRun.get(row.runId) ?? []), result]);
  }
  const waiting = new Set(approvalRows.map((row) => row.runId));
  const now = new Date();
  const counts = { completed: 0, running: 0, interrupted: 0, failed: 0, needsYou: 0 };
  const view = runRows.map((row) => {
    const header = readRunHeader(row.headerJson);
    const outcome = outcomeOf({
      status: row.status, sealed: row.signature !== null, startedAt: row.startedAt, endedAt: row.endedAt,
      stepResults: resultsByRun.get(row.id) ?? [], now, waitingForApproval: waiting.has(row.id), heartbeatAt: row.heartbeatAt,
    });
    if (waiting.has(row.id)) counts.needsYou += 1;
    else if (outcome.outcome === "verified" || outcome.outcome === "finished") counts.completed += 1;
    else if (outcome.outcome === "running") counts.running += 1;
    else if (outcome.outcome === "interrupted" || outcome.outcome === "not_sealed") counts.interrupted += 1;
    else if (outcome.outcome === "failed") counts.failed += 1;
    else if (outcome.outcome === "needs_you" || outcome.outcome === "asked_you" || outcome.outcome === "paused") counts.needsYou += 1;
    return {
      runId: row.id,
      agentId: row.agentId,
      agentName: (header.agentName || "Unknown agent").slice(0, 120),
      label: (row.label || header.task || "Untitled task").slice(0, 160),
      outcome: outcome.outcome,
      outcomeLabel: outcome.label,
      sealed: row.signature !== null,
    };
  });

  return chatCardSchema.parse({
    type: "crew_report",
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    timezone,
    counts,
    totalRuns: view.length,
    costMicroUsd: Number(costRows[0]?.cost ?? 0),
    runs: view.slice(0, 10),
  }) as CrewReportCard;
}

async function sessionFor(tx: Transaction, ownerId: string, agentId: string): Promise<string> {
  const existing = await tx.select({ id: chatSessions.id }).from(chatSessions)
    .where(and(eq(chatSessions.ownerId, ownerId), eq(chatSessions.agentId, agentId))).limit(1);
  if (existing[0]) return existing[0].id;
  await tx.insert(chatSessions).values({ id: randomUUID(), ownerId, agentId })
    .onConflictDoNothing({ target: [chatSessions.ownerId, chatSessions.agentId] });
  const created = await tx.select({ id: chatSessions.id }).from(chatSessions)
    .where(and(eq(chatSessions.ownerId, ownerId), eq(chatSessions.agentId, agentId))).limit(1);
  if (!created[0]) throw new Error("report_session_failed");
  return created[0].id;
}

async function existingDelivery(database: Database, ownerId: string, scheduledAt: Date) {
  const rows = await database.select({ messageId: crewReportDeliveries.messageId }).from(crewReportDeliveries)
    .where(and(eq(crewReportDeliveries.ownerId, ownerId), eq(crewReportDeliveries.scheduledAt, scheduledAt))).limit(1);
  return rows[0];
}

export async function deliverCrewReport(
  database: Database, ownerId: string,
  input: { scheduledAt: Date; timezone: string; manual?: boolean },
): Promise<ReportDeliveryResult> {
  const settings = await database.select({
    recipientAgentId: crewReportSettings.recipientAgentId,
    enabled: crewReportSettings.enabled,
    localTime: crewReportSettings.localTime,
  }).from(crewReportSettings).where(eq(crewReportSettings.ownerId, ownerId)).limit(1);
  const current = settings[0];
  const scheduledAt = input.scheduledAt;
  const { windowStart, windowEnd } = reportWindow(scheduledAt);
  const base = { scheduledAt: scheduledAt.toISOString(), windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString() };

  // A worker rechecks the current settings: disabling or removing the recipient blocks a queued delivery.
  if (!input.manual && (!current?.enabled || !current.recipientAgentId)) {
    return { ...base, status: "skipped", messageId: null, card: null };
  }
  const recipientId = current?.recipientAgentId ?? null;
  if (!recipientId) throw new RequestError(400, "recipient_required");
  const target = await recipient(database, ownerId, recipientId);
  if (!target || target.status !== "active") {
    if (input.manual) throw new RequestError(409, "recipient_unavailable");
    // Mark the occurrence handled without a card so the tick does not retry every minute.
    await database.insert(crewReportDeliveries).values({
      id: randomUUID(), ownerId, recipientAgentId: recipientId, scheduledAt, timezone: input.timezone, messageId: null,
    }).onConflictDoNothing({ target: [crewReportDeliveries.ownerId, crewReportDeliveries.scheduledAt] });
    return { ...base, status: "skipped", messageId: null, card: null, code: "recipient_unavailable" };
  }

  const card = await buildCrewReport(database, ownerId, scheduledAt, input.timezone);
  const deliveryId = randomUUID();
  let messageId: string | null = null;
  let duplicate = false;
  await database.transaction(async (tx) => {
    const inserted = await tx.insert(crewReportDeliveries).values({
      id: deliveryId, ownerId, recipientAgentId: recipientId, scheduledAt, timezone: input.timezone, messageId: null,
    }).onConflictDoNothing({ target: [crewReportDeliveries.ownerId, crewReportDeliveries.scheduledAt] }).returning({ id: crewReportDeliveries.id });
    if (!inserted[0]) { duplicate = true; return; }
    const sessionId = await sessionFor(tx, ownerId, recipientId);
    messageId = randomUUID();
    await tx.insert(messages).values({
      id: messageId, ownerId, sessionId, role: "system", cardType: "crew_report", content: card, sourceTag: "system", runId: null,
    });
    await tx.update(crewReportDeliveries).set({ messageId }).where(eq(crewReportDeliveries.id, deliveryId));
  });
  if (duplicate) {
    const existing = await existingDelivery(database, ownerId, scheduledAt);
    return { ...base, status: "duplicate", messageId: existing?.messageId ?? null, card: null };
  }
  return { ...base, status: "delivered", messageId, card };
}

// Manual "Report now": the same minute is the same request; the card shows its exact window.
export async function generateReportNow(database: Database, ownerId: string): Promise<ReportDeliveryResult> {
  const timezone = await ownerTimezone(database, ownerId);
  const now = new Date();
  const scheduledAt = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  return deliverCrewReport(database, ownerId, { scheduledAt, timezone, manual: true });
}

// One tick per minute. The latest due local occurrence is considered once; a schedule change only applies after it.
export async function tickCrewReports(
  database: Database,
  enqueue: (ownerId: string, scheduledAt: Date, timezone: string) => Promise<boolean>,
  now = new Date(),
): Promise<number> {
  const rows = await database.select({
    ownerId: crewReportSettings.ownerId,
    localTime: crewReportSettings.localTime,
    updatedAt: crewReportSettings.updatedAt,
    timezone: owner.timezone,
    crewStoppedAt: owner.crewStoppedAt,
  }).from(crewReportSettings).innerJoin(owner, eq(owner.id, crewReportSettings.ownerId))
    .where(eq(crewReportSettings.enabled, true)).limit(2);
  let queued = 0;
  for (const row of rows) {
    if (row.crewStoppedAt) continue;
    const local = parseLocalTime(row.localTime);
    if (!local) continue;
    const occurrence = mostRecentLocalTime(now, row.timezone, local);
    if (!occurrence || occurrence.getTime() <= row.updatedAt.getTime()) continue;
    const existing = await existingDelivery(database, row.ownerId, occurrence);
    if (existing) continue;
    try {
      if (await enqueue(row.ownerId, occurrence, row.timezone)) queued += 1;
    } catch {
      console.error("Crew report tick skipped one owner.");
    }
  }
  return queued;
}
