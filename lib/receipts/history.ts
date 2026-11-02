import "server-only";

import { and, asc, desc, eq, inArray } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { checkpoints, runs, stepEvidence, steps } from "../../db/schema";
import { verifyRunExport } from "./chain.mjs";
import { stepResultOf, summarizeRun, viewStep, type ChainState, type RunDetail, type RunSummary } from "./history-view";
import { loadRunExport } from "./store";

type Database = Awaited<ReturnType<typeof getDatabase>>;

export const MAX_LISTED_RUNS = 20;

// TASK-031. Read-only views over the proof tables, always scoped by owner. The History tab uses these.
export async function listRuns(database: Database, ownerId: string, agentId: string, limit = MAX_LISTED_RUNS, now = new Date()): Promise<RunSummary[]> {
  const rows = await database.select().from(runs)
    .where(and(eq(runs.ownerId, ownerId), eq(runs.agentId, agentId)))
    .orderBy(desc(runs.startedAt)).limit(Math.min(Math.max(limit, 1), MAX_LISTED_RUNS));
  if (!rows.length) return [];
  const results = await database.select({ runId: steps.runId, idx: steps.idx, receiptJson: steps.receiptJson }).from(steps)
    .where(and(eq(steps.ownerId, ownerId), inArray(steps.runId, rows.map((row) => row.id)))).orderBy(asc(steps.idx));
  const byRun = new Map<string, string[]>();
  for (const row of results) byRun.set(row.runId, [...(byRun.get(row.runId) ?? []), stepResultOf(row.receiptJson)]);
  return rows.map((row) => summarizeRun({
    runId: row.id, headerText: row.headerJson, startedAt: row.startedAt, endedAt: row.endedAt, sealed: row.signature !== null,
    status: row.status, stepResults: byRun.get(row.id) ?? [], now,
  }));
}

// The full timeline of one run, with the chain checked right now. null when the run is unknown or belongs to someone else.
export async function loadRunDetail(database: Database, ownerId: string, runId: string, now = new Date()): Promise<RunDetail | null> {
  const exported = await loadRunExport(database, ownerId, runId);
  if (!exported) return null;
  const found = await database.select().from(runs).where(and(eq(runs.id, runId), eq(runs.ownerId, ownerId))).limit(1);
  const run = found[0];
  if (!run) return null;
  const evidence = await database.select().from(stepEvidence).where(and(eq(stepEvidence.runId, runId), eq(stepEvidence.ownerId, ownerId)));
  const evidenceByIdx = new Map(evidence.map((row) => [row.idx, row]));
  const saved = await database.select({ idx: checkpoints.idx, status: checkpoints.status, reason: checkpoints.reason }).from(checkpoints)
    .where(and(eq(checkpoints.runId, runId), eq(checkpoints.ownerId, ownerId)));
  const checkpointByIdx = new Map(saved.map((row) => [row.idx, { status: row.status === "complete" ? "complete" as const : "partial" as const, reason: row.reason }]));

  const stepViews = exported.steps.map((step) => viewStep(step.receipt, step.receipt_hash, step.prev_hash, step.idx, evidenceByIdx.get(step.idx) ?? null, checkpointByIdx.get(step.idx) ?? null));
  const verdict = verifyRunExport(exported);
  const chain: ChainState = verdict.ok ? { state: "verified" }
    : verdict.reason === "unsealed" ? { state: "unsealed" }
    : { state: "failed", reason: verdict.reason, step: verdict.step ?? null };
  const summary = summarizeRun({
    runId, headerText: run.headerJson, startedAt: run.startedAt, endedAt: run.endedAt, sealed: run.signature !== null,
    status: run.status, stepResults: stepViews.map((step) => step.result), now,
  });

  // TASK-043. Runs whose signed header names this run as their origin. The column is only a query index.
  const branchRows = await database.select().from(runs)
    .where(and(eq(runs.ownerId, ownerId), eq(runs.branchOf, runId)))
    .orderBy(desc(runs.startedAt)).limit(MAX_LISTED_RUNS);
  let branches: RunSummary[] = [];
  if (branchRows.length) {
    const branchSteps = await database.select({ runId: steps.runId, idx: steps.idx, receiptJson: steps.receiptJson }).from(steps)
      .where(and(eq(steps.ownerId, ownerId), inArray(steps.runId, branchRows.map((row) => row.id)))).orderBy(asc(steps.idx));
    const byBranch = new Map<string, string[]>();
    for (const row of branchSteps) byBranch.set(row.runId, [...(byBranch.get(row.runId) ?? []), stepResultOf(row.receiptJson)]);
    branches = branchRows.map((row) => summarizeRun({
      runId: row.id, headerText: row.headerJson, startedAt: row.startedAt, endedAt: row.endedAt, sealed: row.signature !== null,
      status: row.status, stepResults: byBranch.get(row.id) ?? [], now,
    }));
  }
  const baseline = checkpointByIdx.get(0);
  return {
    run: summary, agentId: run.agentId, keyId: run.keyId, chain, steps: stepViews, branches,
    baselineCheckpoint: !baseline ? "missing" : baseline.status === "complete" ? "saved" : "partial",
  };
}

// True only when `hash` is a stored before/after screenshot of a step in this owner's run. Gates the image route.
export async function evidenceBelongsToRun(database: Database, ownerId: string, runId: string, hash: string): Promise<boolean> {
  const rows = await database.select({ beforeHash: stepEvidence.beforeHash, afterHash: stepEvidence.afterHash }).from(stepEvidence)
    .where(and(eq(stepEvidence.runId, runId), eq(stepEvidence.ownerId, ownerId)));
  return rows.some((row) => row.beforeHash === hash || row.afterHash === hash);
}

// The agent a run belongs to, for ownership checks before listing. null for a foreign or unknown run.
export async function runAgentId(database: Database, ownerId: string, runId: string): Promise<string | null> {
  const found = await database.select({ agentId: runs.agentId }).from(runs).where(and(eq(runs.id, runId), eq(runs.ownerId, ownerId))).limit(1);
  return found[0]?.agentId ?? null;
}
