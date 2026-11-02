import "server-only";

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { agents, replayScriptProposals, replayScripts, replayScriptVersions, runs } from "../../db/schema";
import { verifyRunExport } from "../receipts/chain.mjs";
import { loadRunExport } from "../receipts/store";
import { MAX_REPLAY_STEPS, compileFromReceipts, defaultScriptName, replayStepsSchema, type CompileReason, type ReplayStep } from "./script";
import { toStepViews, type ReplayScriptView } from "./view";

type Database = Awaited<ReturnType<typeof getDatabase>>;

// TASK-041/TASK-044. Owner-scoped access to saved replay scripts and their approved versions. Every query carries owner_id;
// scripts are immutable. Version 1 is the base row; each approved self-heal repair appends one version.
export interface StoredScript {
  id: string;
  ownerId: string;
  agentId: string;
  name: string;
  steps: ReplayStep[];
  sourceRunId: string;
  createdAt: Date;
  version: number;
  pendingProposalId: string | null;
}

export const scriptView = (script: StoredScript): ReplayScriptView => ({
  id: script.id, name: script.name, stepCount: script.steps.length, createdAt: script.createdAt.toISOString(),
  sourceRunId: script.sourceRunId, version: script.version, pendingProposalId: script.pendingProposalId,
  steps: toStepViews(script.steps),
});

function toBase(row: typeof replayScripts.$inferSelect): StoredScript | null {
  // The column is jsonb written by this module, but it is read back through the same schema: a damaged row is not replayed.
  const parsed = replayStepsSchema.safeParse(row.steps);
  if (!parsed.success) return null;
  return {
    id: row.id, ownerId: row.ownerId, agentId: row.agentId, name: row.name, steps: parsed.data,
    sourceRunId: row.sourceRunId, createdAt: row.createdAt, version: 1, pendingProposalId: null,
  };
}

type VersionRow = typeof replayScriptVersions.$inferSelect;
const latestByScript = (rows: readonly VersionRow[]): Map<string, { version: number; steps: ReplayStep[] } | null> => {
  const latest = new Map<string, { version: number; steps: ReplayStep[] } | null>();
  for (const row of rows) {
    if (latest.has(row.scriptId)) continue;
    const parsed = replayStepsSchema.safeParse(row.steps);
    latest.set(row.scriptId, parsed.success ? { version: row.version, steps: parsed.data } : null);
  }
  return latest;
};

const pendingByScript = async (database: Database, ownerId: string, scriptIds: string[]): Promise<Map<string, string>> => {
  if (!scriptIds.length) return new Map();
  const rows = await database.select({ id: replayScriptProposals.id, scriptId: replayScriptProposals.scriptId })
    .from(replayScriptProposals)
    .where(and(eq(replayScriptProposals.ownerId, ownerId), inArray(replayScriptProposals.scriptId, scriptIds), eq(replayScriptProposals.status, "pending")));
  return new Map(rows.map((row) => [row.scriptId, row.id]));
};

export async function listScripts(database: Database, ownerId: string, agentId: string): Promise<StoredScript[]> {
  const rows = await database.select().from(replayScripts)
    .where(and(eq(replayScripts.ownerId, ownerId), eq(replayScripts.agentId, agentId)))
    .orderBy(desc(replayScripts.createdAt)).limit(50);
  if (!rows.length) return [];
  const scriptIds = rows.map((row) => row.id);
  const versions = await database.select().from(replayScriptVersions)
    .where(and(eq(replayScriptVersions.ownerId, ownerId), inArray(replayScriptVersions.scriptId, scriptIds)))
    .orderBy(desc(replayScriptVersions.version));
  const latest = latestByScript(versions);
  const pending = await pendingByScript(database, ownerId, scriptIds);
  return rows.flatMap((row) => {
    const base = toBase(row);
    if (!base) return [];
    const latestVersion = latest.get(row.id);
    if (latest.has(row.id) && !latestVersion) return [];
    const resolved = latestVersion ?? { version: 1, steps: base.steps };
    return [{ ...base, steps: resolved.steps, version: resolved.version, pendingProposalId: pending.get(row.id) ?? null }];
  });
}

export async function getScript(database: Database, ownerId: string, scriptId: string): Promise<StoredScript | null> {
  const rows = await database.select().from(replayScripts)
    .where(and(eq(replayScripts.ownerId, ownerId), eq(replayScripts.id, scriptId))).limit(1);
  const base = rows[0] ? toBase(rows[0]) : null;
  if (!base) return null;

  const versions = await database.select().from(replayScriptVersions)
    .where(and(eq(replayScriptVersions.ownerId, ownerId), eq(replayScriptVersions.scriptId, scriptId)))
    .orderBy(desc(replayScriptVersions.version)).limit(1);
  if (versions[0]) {
    const parsed = replayStepsSchema.safeParse(versions[0].steps);
    if (!parsed.success) return null;
    base.steps = parsed.data;
    base.version = versions[0].version;
  }
  const pending = await database.select({ id: replayScriptProposals.id }).from(replayScriptProposals)
    .where(and(eq(replayScriptProposals.ownerId, ownerId), eq(replayScriptProposals.scriptId, scriptId), eq(replayScriptProposals.status, "pending"))).limit(1);
  base.pendingProposalId = pending[0]?.id ?? null;
  return base;
}

export async function deleteScript(database: Database, ownerId: string, scriptId: string): Promise<boolean> {
  const removed = await database.delete(replayScripts)
    .where(and(eq(replayScripts.ownerId, ownerId), eq(replayScripts.id, scriptId))).returning({ id: replayScripts.id });
  return removed.length === 1;
}

export type CompileRunResult =
  | { ok: true; script: StoredScript; created: boolean }
  | { ok: false; error: "run_not_found" | "agent_not_found" | "script_unreadable" }
  | { ok: false; error: "not_replayable"; reasons: CompileReason[] };

// Compiles one finished run. The chain is verified first, so a tampered or unsealed run never becomes a script. Compiling the
// same run twice returns the first script (one script per source run).
export async function compileRun(database: Database, ownerId: string, runId: string, name?: string): Promise<CompileRunResult> {
  const exported = await loadRunExport(database, ownerId, runId);
  if (!exported) return { ok: false, error: "run_not_found" };
  const runRows = await database.select().from(runs).where(and(eq(runs.id, runId), eq(runs.ownerId, ownerId))).limit(1);
  const run = runRows[0];
  if (!run) return { ok: false, error: "run_not_found" };

  const existing = await database.select().from(replayScripts)
    .where(and(eq(replayScripts.ownerId, ownerId), eq(replayScripts.sourceRunId, runId))).limit(1);
  if (existing[0]) {
    const stored = await getScript(database, ownerId, existing[0].id);
    return stored ? { ok: true, script: stored, created: false } : { ok: false, error: "script_unreadable" };
  }

  if (!verifyRunExport(exported).ok) return { ok: false, error: "not_replayable", reasons: [{ step: null, code: "chain_invalid" }] };
  if (run.status !== "finished") return { ok: false, error: "not_replayable", reasons: [{ step: null, code: "run_not_verified" }] };

  const compiled = compileFromReceipts(exported.steps.map((step) => ({ idx: step.idx, receipt: step.receipt })));
  if (!compiled.ok) return { ok: false, error: "not_replayable", reasons: compiled.reasons };
  if (compiled.steps.length > MAX_REPLAY_STEPS) return { ok: false, error: "not_replayable", reasons: [{ step: null, code: "too_many_steps" }] };

  const agent = await database.select({ id: agents.id }).from(agents).where(and(eq(agents.id, run.agentId), eq(agents.ownerId, ownerId))).limit(1);
  if (!agent[0]) return { ok: false, error: "agent_not_found" };

  let task = "";
  try { const header = JSON.parse(run.headerJson) as { task?: unknown }; task = typeof header.task === "string" ? header.task : ""; } catch { task = ""; }
  const id = randomUUID();
  const inserted = await database.insert(replayScripts).values({
    id, ownerId, agentId: run.agentId, sourceRunId: runId, name: name ?? defaultScriptName(task), steps: compiled.steps, stepCount: compiled.steps.length,
  }).onConflictDoNothing({ target: replayScripts.sourceRunId }).returning();
  const row = inserted[0] ?? (await database.select().from(replayScripts)
    .where(and(eq(replayScripts.ownerId, ownerId), eq(replayScripts.sourceRunId, runId))).limit(1))[0];
  const stored = row ? await getScript(database, ownerId, row.id) : null;
  return stored ? { ok: true, script: stored, created: inserted.length === 1 } : { ok: false, error: "script_unreadable" };
}
