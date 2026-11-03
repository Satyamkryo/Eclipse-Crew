import "server-only";

import { and, desc, eq, isNull } from "drizzle-orm";
import type { getDatabase } from "../../db/client";
import { runMeta, runs, steps } from "../../db/schema";
import { isRunActive } from "../jobs/control";
import { compactStep, viewStep, type CompactStep } from "../receipts/history-view";

type Database = Awaited<ReturnType<typeof getDatabase>>;
export interface LiveHelper {
  runId: string;
  label: string;
  state: "running" | "finished" | "stopped";
  steps: CompactStep[];
  costMicroUsd: number;
}
export interface LiveRun {
  runId: string;
  startedAt: string;
  steps: CompactStep[];
  costMicroUsd: number;
  // TASK-076. Screenless helpers appear indented under the parent.
  helpers: LiveHelper[];
}

// TASK-083. The newest unsealed run that this app process still holds, with its last 20 compact steps.
// Returns null when nothing is live, so the chat hides the card without a second source of truth.
export async function loadLiveRun(database: Database, ownerId: string, agentId: string): Promise<LiveRun | null> {
  const current = await database.select({ id: runs.id, startedAt: runs.startedAt }).from(runs)
    .where(and(eq(runs.ownerId, ownerId), eq(runs.agentId, agentId), isNull(runs.signature)))
    .orderBy(desc(runs.startedAt)).limit(1);
  const run = current[0];
  if (!run || !isRunActive(ownerId, run.id)) return null;
  const rows = await database.select({ idx: steps.idx, receiptJson: steps.receiptJson, receiptHash: steps.receiptHash, prevHash: steps.prevHash })
    .from(steps).where(and(eq(steps.ownerId, ownerId), eq(steps.runId, run.id))).orderBy(desc(steps.idx)).limit(20);
  const views = rows.reverse().map((row) => compactStep(viewStep(row.receiptJson, row.receiptHash, row.prevHash, row.idx, null)));
  const helperRuns = await database.select({ runId: runMeta.runId, label: runMeta.label }).from(runMeta)
    .where(and(eq(runMeta.ownerId, ownerId), eq(runMeta.parentRunId, run.id))).limit(3);
  const helpers: LiveHelper[] = [];
  for (const helper of helperRuns) {
    const helperSteps = await database.select({ idx: steps.idx, receiptJson: steps.receiptJson, receiptHash: steps.receiptHash, prevHash: steps.prevHash })
      .from(steps).where(and(eq(steps.ownerId, ownerId), eq(steps.runId, helper.runId))).orderBy(desc(steps.idx)).limit(10);
    const helperViews = helperSteps.reverse().map((row) => compactStep(viewStep(row.receiptJson, row.receiptHash, row.prevHash, row.idx, null)));
    const sealed = await database.select({ signature: runs.signature, status: runs.status }).from(runs)
      .where(and(eq(runs.ownerId, ownerId), eq(runs.id, helper.runId))).limit(1);
    const live = !sealed[0]?.signature;
    helpers.push({
      runId: helper.runId, label: helper.label ?? "Helper",
      state: live ? "running" : sealed[0]?.status === "finished" ? "finished" : "stopped",
      steps: helperViews, costMicroUsd: helperViews.reduce((sum, step) => sum + (step.costMicroUsd ?? 0), 0),
    });
  }
  return { runId: run.id, startedAt: run.startedAt.toISOString(), steps: views,
    costMicroUsd: views.reduce((sum, step) => sum + (step.costMicroUsd ?? 0), 0), helpers };
}
