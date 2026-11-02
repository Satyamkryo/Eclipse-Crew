import "server-only";

import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { replayScriptProposals, replayScripts, replayScriptVersions } from "../../db/schema";
import { affectedCount, diffSteps } from "../replay/diff";
import { replayStepsSchema, type ReplayStep } from "../replay/script";
import { stepText } from "../replay/view";
import { isHealFailureCode, type HealFailureCode } from "./codes";
import { healReason, type ProposalStatus, type SkillUpdateDetail } from "./view";

type Database = Awaited<ReturnType<typeof getDatabase>>;
type ProposalRow = typeof replayScriptProposals.$inferSelect;

// TASK-044. Owner-scoped proposals and approved versions. Versions are append-only; a proposal is written once and then only
// its status/decided_at change. Every read re-validates the stored steps.
export interface StoredProposal {
  id: string;
  ownerId: string;
  agentId: string;
  scriptId: string;
  baseVersion: number;
  proposedVersion: number;
  failedStep: number;
  failureCode: HealFailureCode;
  replayRunId: string;
  healRunId: string;
  steps: ReplayStep[];
  stepCount: number;
  status: ProposalStatus;
  decidedAt: Date | null;
  createdAt: Date;
}

function toStored(row: ProposalRow): StoredProposal | null {
  const parsed = replayStepsSchema.safeParse(row.steps);
  const status = row.status === "pending" || row.status === "approved" || row.status === "rejected" ? row.status : null;
  if (!parsed.success || !status || !isHealFailureCode(row.failureCode)) return null;
  return {
    id: row.id, ownerId: row.ownerId, agentId: row.agentId, scriptId: row.scriptId,
    baseVersion: row.baseVersion, proposedVersion: row.proposedVersion, failedStep: row.failedStep,
    failureCode: row.failureCode, replayRunId: row.replayRunId, healRunId: row.healRunId,
    steps: parsed.data, stepCount: row.stepCount, status, decidedAt: row.decidedAt, createdAt: row.createdAt,
  };
}

async function latestVersionNumber(database: Database, ownerId: string, scriptId: string): Promise<number> {
  const rows = await database.select({ version: replayScriptVersions.version }).from(replayScriptVersions)
    .where(and(eq(replayScriptVersions.ownerId, ownerId), eq(replayScriptVersions.scriptId, scriptId)))
    .orderBy(desc(replayScriptVersions.version)).limit(1);
  return rows[0]?.version ?? 1;
}

async function stepsAt(database: Database, ownerId: string, scriptId: string, version: number): Promise<ReplayStep[] | null> {
  if (version === 1) {
    const rows = await database.select({ steps: replayScripts.steps }).from(replayScripts)
      .where(and(eq(replayScripts.ownerId, ownerId), eq(replayScripts.id, scriptId))).limit(1);
    if (!rows[0]) return null;
    const parsed = replayStepsSchema.safeParse(rows[0].steps);
    return parsed.success ? parsed.data : null;
  }
  const rows = await database.select({ steps: replayScriptVersions.steps }).from(replayScriptVersions)
    .where(and(eq(replayScriptVersions.ownerId, ownerId), eq(replayScriptVersions.scriptId, scriptId), eq(replayScriptVersions.version, version))).limit(1);
  if (!rows[0]) return null;
  const parsed = replayStepsSchema.safeParse(rows[0].steps);
  return parsed.success ? parsed.data : null;
}

// The version a replay would run now, and its steps. null when the script is missing or the latest version is damaged.
export async function latestVersion(database: Database, ownerId: string, scriptId: string): Promise<{ version: number; steps: ReplayStep[] } | null> {
  const rows = await database.select({ id: replayScripts.id }).from(replayScripts)
    .where(and(eq(replayScripts.ownerId, ownerId), eq(replayScripts.id, scriptId))).limit(1);
  if (!rows[0]) return null;
  const version = await latestVersionNumber(database, ownerId, scriptId);
  const steps = await stepsAt(database, ownerId, scriptId, version);
  return steps ? { version, steps } : null;
}

export async function hasPendingProposal(database: Database, ownerId: string, scriptId: string): Promise<boolean> {
  const rows = await database.select({ id: replayScriptProposals.id }).from(replayScriptProposals)
    .where(and(eq(replayScriptProposals.ownerId, ownerId), eq(replayScriptProposals.scriptId, scriptId), eq(replayScriptProposals.status, "pending"))).limit(1);
  return rows.length === 1;
}

export async function getProposal(database: Database, ownerId: string, proposalId: string): Promise<StoredProposal | null> {
  const rows = await database.select().from(replayScriptProposals)
    .where(and(eq(replayScriptProposals.ownerId, ownerId), eq(replayScriptProposals.id, proposalId))).limit(1);
  return rows[0] ? toStored(rows[0]) : null;
}

export type CreateProposalInput = {
  ownerId: string;
  agentId: string;
  scriptId: string;
  baseVersion: number;
  failedStep: number;
  failureCode: HealFailureCode;
  replayRunId: string;
  healRunId: string;
  steps: readonly ReplayStep[];
};

export type CreateProposalResult =
  | { ok: true; proposal: StoredProposal }
  | { ok: false; error: "stale" | "conflict" | "invalid" };

// Writes one pending proposal. A stale base means the script changed while the repair ran; a conflict means another repair
// already proposed an update for this script (or this heal run). Neither overwrites anything.
export async function createProposal(database: Database, input: CreateProposalInput): Promise<CreateProposalResult> {
  const parsed = replayStepsSchema.safeParse(input.steps);
  if (!parsed.success || !isHealFailureCode(input.failureCode) || parsed.data.length !== input.steps.length) return { ok: false, error: "invalid" };
  if (!Number.isInteger(input.baseVersion) || input.baseVersion < 1) return { ok: false, error: "invalid" };

  return database.transaction(async (tx) => {
    const script = await tx.select({ id: replayScripts.id }).from(replayScripts)
      .where(and(eq(replayScripts.ownerId, input.ownerId), eq(replayScripts.id, input.scriptId))).limit(1);
    if (!script[0]) return { ok: false, error: "stale" } as const;

    const versions = await tx.select({ version: replayScriptVersions.version }).from(replayScriptVersions)
      .where(and(eq(replayScriptVersions.ownerId, input.ownerId), eq(replayScriptVersions.scriptId, input.scriptId)))
      .orderBy(desc(replayScriptVersions.version)).limit(1);
    if ((versions[0]?.version ?? 1) !== input.baseVersion) return { ok: false, error: "stale" } as const;

    const inserted = await tx.insert(replayScriptProposals).values({
      id: randomUUID(), ownerId: input.ownerId, agentId: input.agentId, scriptId: input.scriptId,
      baseVersion: input.baseVersion, proposedVersion: input.baseVersion + 1, failedStep: input.failedStep,
      failureCode: input.failureCode, replayRunId: input.replayRunId, healRunId: input.healRunId,
      steps: parsed.data, stepCount: parsed.data.length,
    }).onConflictDoNothing().returning();
    const stored = inserted[0] ? toStored(inserted[0]) : null;
    return stored ? { ok: true, proposal: stored } as const : { ok: false, error: "conflict" } as const;
  });
}

export type DecideResult =
  | { ok: true; proposal: StoredProposal }
  | { ok: false; error: "not_found" | "already_decided" | "stale" | "invalid" };

// Approving appends version base+1 in the same transaction. A second decision, a stale base or a lost race changes nothing.
export async function decideProposal(
  database: Database, ownerId: string, proposalId: string, decision: "approve" | "reject",
): Promise<DecideResult> {
  try {
    return await database.transaction(async (tx) => {
      const rows = await tx.select().from(replayScriptProposals)
        .where(and(eq(replayScriptProposals.ownerId, ownerId), eq(replayScriptProposals.id, proposalId))).limit(1);
      const proposal = rows[0] ? toStored(rows[0]) : null;
      if (!proposal) return { ok: false, error: "not_found" } as const;
      if (proposal.status !== "pending") return { ok: false, error: "already_decided" } as const;

      const versions = await tx.select({ version: replayScriptVersions.version }).from(replayScriptVersions)
        .where(and(eq(replayScriptVersions.ownerId, ownerId), eq(replayScriptVersions.scriptId, proposal.scriptId)))
        .orderBy(desc(replayScriptVersions.version)).limit(1);
      if ((versions[0]?.version ?? 1) !== proposal.baseVersion) return { ok: false, error: "stale" } as const;
      if (decision === "approve" && proposal.steps.length !== proposal.stepCount) return { ok: false, error: "invalid" } as const;

      // The conditional update is the decision. Losing the race writes nothing; a failed version insert rolls it back.
      const now = new Date();
      const updated = await tx.update(replayScriptProposals)
        .set({ status: decision === "approve" ? "approved" : "rejected", decidedAt: now })
        .where(and(eq(replayScriptProposals.ownerId, ownerId), eq(replayScriptProposals.id, proposalId), eq(replayScriptProposals.status, "pending")))
        .returning();
      if (!updated[0]) return { ok: false, error: "already_decided" } as const;

      if (decision === "approve") {
        await tx.insert(replayScriptVersions).values({
          id: randomUUID(), ownerId, scriptId: proposal.scriptId, version: proposal.proposedVersion,
          steps: proposal.steps, stepCount: proposal.steps.length, sourceRunId: proposal.healRunId,
        });
      }
      const stored = toStored(updated[0]);
      return stored ? { ok: true, proposal: stored } as const : { ok: false, error: "invalid" } as const;
    });
  } catch (error) {
    // A unique (script, version) conflict means another decision won; the status update above rolled back with it.
    if ((error as { code?: unknown }).code === "23505") return { ok: false, error: "stale" };
    throw error;
  }
}

// Everything the review view needs. The diff is against the version the proposal was based on, never the latest one.
export async function buildProposalDetail(database: Database, ownerId: string, proposalId: string): Promise<SkillUpdateDetail | null> {
  const proposal = await getProposal(database, ownerId, proposalId);
  if (!proposal) return null;
  const scriptRows = await database.select({ name: replayScripts.name }).from(replayScripts)
    .where(and(eq(replayScripts.ownerId, ownerId), eq(replayScripts.id, proposal.scriptId))).limit(1);
  if (!scriptRows[0]) return null;
  const base = await stepsAt(database, ownerId, proposal.scriptId, proposal.baseVersion);
  if (!base) return null;

  const diff = diffSteps(base, proposal.steps);
  const failed = base[proposal.failedStep - 1];
  const latest = await latestVersionNumber(database, ownerId, proposal.scriptId);
  return {
    id: proposal.id, scriptId: proposal.scriptId, scriptName: scriptRows[0].name, agentId: proposal.agentId,
    fromVersion: proposal.baseVersion, toVersion: proposal.proposedVersion, status: proposal.status,
    failedStep: proposal.failedStep, failureCode: proposal.failureCode,
    reason: healReason(proposal.failureCode, failed ? stepText(failed) : "The saved step."),
    changedSteps: affectedCount(diff), oldStepCount: base.length, newStepCount: proposal.steps.length,
    diff, healRunId: proposal.healRunId, replayRunId: proposal.replayRunId,
    stale: latest !== proposal.baseVersion, canDecide: proposal.status === "pending",
    createdAt: proposal.createdAt.toISOString(), decidedAt: proposal.decidedAt?.toISOString() ?? null,
  };
}
