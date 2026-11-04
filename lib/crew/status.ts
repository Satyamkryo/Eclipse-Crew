import "server-only";

import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { approvals, costEntries, runs, steps } from "../../db/schema";
import { listAgentRecords } from "../agents/data";
import { desktopSession } from "../desktop/client";
import { outcomeOf, readRunHeader } from "../jobs/view";
import type { RunTone } from "../receipts/history-view";
import { createModelSettingsStore } from "../models/data";
import { localDayBounds } from "./time";

type Database = Awaited<ReturnType<typeof getDatabase>>;

const RUNNING_HEARTBEAT_MS = 90_000;
const MAX_DESKTOP_CHECKS = 50;

export type CrewAttention = "budget_warning" | "budget_paused" | "security_stop" | "approval_pending" | "teach_paused" | null;

export interface CrewAgentStatus {
  id: string;
  name: string;
  role: string;
  status: "active" | "paused";
  astraMode: boolean;
  attention: CrewAttention;
  desktop: "running" | "stopped" | "unavailable";
  // Only a running graphics desktop gets a generation. The page never starts one to fill the overview.
  streamGeneration: string | null;
  model: string | null;
  todayCostMicroUsd: number;
  pendingApprovals: number;
  currentRun: {
    runId: string;
    label: string;
    stepCount: number;
    startedAt: string;
    heartbeatAt: string | null;
    costMicroUsd: number;
    outcome: string;
    outcomeLabel: string;
    tone: RunTone;
  } | null;
}

export interface CrewStatusView {
  agents: CrewAgentStatus[];
  timezone: string;
  dayStart: string;
  dayEnd: string;
  generatedAt: string;
  totals: { todayCostMicroUsd: number; running: number; needsYou: number };
}

function attentionOf(value: string | null): CrewAttention {
  return value === "budget_warning" || value === "budget_paused" || value === "security_stop" ||
    value === "approval_pending" || value === "teach_paused" ? value : null;
}

export async function loadCrewStatus(
  database: Database, ownerId: string, timezone: string, now = new Date(),
  desktopStatus: typeof desktopSession = desktopSession,
): Promise<CrewStatusView> {
  const records = await listAgentRecords(database, ownerId);
  const ids = records.map((record) => record.id);
  const day = localDayBounds(now, timezone);
  // Every agent stays listed; desktop status checks are bounded so one huge crew cannot fan out without limit.
  const desktopTargets = records.filter((record) => record.status === "active").slice(0, MAX_DESKTOP_CHECKS);

  const [runRows, approvalRows, costRows, modelSettings, desktops] = await Promise.all([
    ids.length === 0 ? [] : database.select({
      id: runs.id,
      agentId: runs.agentId,
      headerJson: runs.headerJson,
      startedAt: runs.startedAt,
      heartbeatAt: runs.heartbeatAt,
      cancelRequestedAt: runs.cancelRequestedAt,
    }).from(runs)
      .where(and(eq(runs.ownerId, ownerId), isNull(runs.signature), inArray(runs.agentId, ids)))
      .orderBy(desc(runs.startedAt)).limit(MAX_DESKTOP_CHECKS * 3),
    ids.length === 0 ? [] : database.select({
      agentId: approvals.agentId,
      count: sql<number>`count(*)::int`,
    }).from(approvals)
      .where(and(eq(approvals.ownerId, ownerId), eq(approvals.state, "pending"), inArray(approvals.agentId, ids)))
      .groupBy(approvals.agentId),
    ids.length === 0 ? [] : database.select({
      agentId: costEntries.agentId,
      cost: sql<number>`coalesce(sum(${costEntries.costMicroUsd}), 0)::bigint`,
    }).from(costEntries)
      .where(and(eq(costEntries.ownerId, ownerId), gte(costEntries.createdAt, day.start), lt(costEntries.createdAt, day.end), inArray(costEntries.agentId, ids)))
      .groupBy(costEntries.agentId),
    createModelSettingsStore(database).load(ownerId).catch(() => null),
    Promise.all(desktopTargets.map(async (record) => {
      try {
        const status = await desktopStatus(record.id, ownerId, "session.status");
        const running = status.state === "running" && status.graphics === "running" && Boolean(status.generation);
        return { agentId: record.id, desktop: running ? "running" as const : "stopped" as const, generation: running ? status.generation ?? null : null };
      } catch {
        return { agentId: record.id, desktop: "unavailable" as const, generation: null };
      }
    })),
  ]);

  // The newest unsealed run is current only while its heartbeat is fresh; anything older is left to Jobs.
  type CurrentRunRow = { id: string; agentId: string; headerJson: string; startedAt: Date; heartbeatAt: Date | null; cancelRequestedAt: Date | null };
  const currentByAgent = new Map<string, CurrentRunRow>();
  for (const row of runRows) {
    if (currentByAgent.has(row.agentId)) continue;
    const heartbeat = row.heartbeatAt?.getTime() ?? 0;
    if (now.getTime() - heartbeat >= RUNNING_HEARTBEAT_MS) continue;
    currentByAgent.set(row.agentId, row);
  }
  const runIds = [...currentByAgent.values()].map((row) => row.id);
  const [stepRows, runCostRows] = await Promise.all([
    runIds.length === 0 ? [] : database.select({
      runId: steps.runId,
      count: sql<number>`count(*)::int`,
    }).from(steps).where(and(eq(steps.ownerId, ownerId), inArray(steps.runId, runIds))).groupBy(steps.runId),
    runIds.length === 0 ? [] : database.select({
      runId: costEntries.runId,
      cost: sql<number>`coalesce(sum(${costEntries.costMicroUsd}), 0)::bigint`,
    }).from(costEntries).where(and(eq(costEntries.ownerId, ownerId), inArray(costEntries.runId, runIds), sql`${costEntries.runId} is not null`))
      .groupBy(costEntries.runId),
  ]);

  const stepByRun = new Map(stepRows.map((row) => [row.runId, Number(row.count)]));
  const costByRun = new Map(runCostRows.map((row) => [row.runId, Number(row.cost)]));
  const approvalByAgent = new Map(approvalRows.map((row) => [row.agentId, Number(row.count)]));
  const todayCostByAgent = new Map(costRows.map((row) => [row.agentId, Number(row.cost)]));
  const desktopByAgent = new Map(desktops.map((entry) => [entry.agentId, entry]));

  const agents: CrewAgentStatus[] = records.map((record) => {
    const current = currentByAgent.get(record.id);
    const header = current ? readRunHeader(current.headerJson) : null;
    const outcome = current ? outcomeOf({
      status: "running", sealed: false, startedAt: current.startedAt, endedAt: null,
      stepResults: [], heartbeatAt: current.heartbeatAt, now,
    }) : null;
    const desktop = desktopByAgent.get(record.id) ?? { desktop: "stopped" as const, generation: null };
    return {
      id: record.id,
      name: record.name,
      role: record.role,
      status: record.status === "active" ? "active" : "paused",
      astraMode: record.astraMode,
      attention: attentionOf(record.attentionReason),
      desktop: desktop.desktop,
      streamGeneration: desktop.generation,
      model: modelSettings?.main?.model ?? null,
      todayCostMicroUsd: todayCostByAgent.get(record.id) ?? 0,
      pendingApprovals: approvalByAgent.get(record.id) ?? 0,
      currentRun: current ? {
        runId: current.id,
        label: (header?.task || "Untitled task").slice(0, 160),
        stepCount: stepByRun.get(current.id) ?? 0,
        startedAt: current.startedAt.toISOString(),
        heartbeatAt: current.heartbeatAt?.toISOString() ?? null,
        costMicroUsd: costByRun.get(current.id) ?? 0,
        outcome: outcome?.outcome ?? "running",
        outcomeLabel: outcome?.label ?? "Running",
        tone: outcome?.tone ?? "neutral",
      } : null,
    };
  });

  return {
    agents,
    timezone,
    dayStart: day.start.toISOString(),
    dayEnd: day.end.toISOString(),
    generatedAt: now.toISOString(),
    totals: {
      todayCostMicroUsd: agents.reduce((sum, agent) => sum + agent.todayCostMicroUsd, 0),
      running: agents.filter((agent) => agent.currentRun !== null).length,
      needsYou: agents.filter((agent) => agent.attention !== null || agent.pendingApprovals > 0).length,
    },
  };
}
