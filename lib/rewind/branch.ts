import "server-only";

import type { getDatabase } from "../../db/client";
import type { StepSummary } from "../agent/context";
import { claimAgent, type RunResume } from "../agent/step-loop";
import { createBlobStore, type BlobStore } from "../artifacts/blob-store";
import { createChatRunPorts, prepareChatRun, type ChatRunPorts } from "../agent/chat-run";
import { loadCheckpoint } from "../checkpoints/store";
import { desktopSession } from "../desktop/client";
import { verifyRunExport } from "../receipts/chain.mjs";
import { runAgentId } from "../receipts/history";
import { loadRunExport } from "../receipts/store";
import { planRestore } from "./plan";
import { applyRestore, preflightBlobs, RestoreError, type RestoredCounts } from "./restore";

type Database = Awaited<ReturnType<typeof getDatabase>>;

export type RewindErrorCode =
  | "invalid_input" | "run_not_found" | "run_not_rewindable" | "step_out_of_range" | "checkpoint_missing"
  | "checkpoint_incomplete" | "file_not_restorable" | "too_many_changes" | "blob_missing"
  | "agent_unavailable" | "no_model" | "no_signing_key" | "takeover_active" | "agent_busy"
  | "restore_failed" | "run_start_failed" | "service_unavailable";

export class RewindError extends Error {
  constructor(public code: RewindErrorCode, public status: number, public restored?: RestoredCounts) {
    super(code);
    this.name = "RewindError";
  }
}

export interface BranchOptions {
  database: Database;
  ownerId: string;
  runId: string;
  step: number;
  correction: string;
  ports?: ChatRunPorts;
  blobs?: BlobStore;
  waitForStartMs?: number;
  // Tests inject this; production reads the desktop session status (which reports an active takeover).
  status?: (agentId: string) => Promise<{ state: string; takenOver?: boolean }>;
}
export interface BranchResult {
  runId: string;
  restored: RestoredCounts & { kept: number };
  starting?: true;
}

// TASK-043. The owner's correction becomes part of the task the model sees. The original task is trimmed from its end if
// needed, so the correction always survives the 2,000-character header/task limit.
export function correctionTask(task: string, correction: string): string {
  const suffix = `\n\nOwner correction: ${correction}`;
  const room = Math.max(0, 2000 - [...suffix].length);
  const original = [...task].slice(0, room).join("").trimEnd();
  return `${original}${suffix}`;
}

const invalidCorrection = (correction: string) =>
  typeof correction !== "string" || !correction.trim() || [...correction].length > 600 ||
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(correction);

export async function startBranch(options: BranchOptions): Promise<BranchResult> {
  const { database, ownerId, runId, step } = options;
  const correction = options.correction;
  if (!Number.isSafeInteger(step) || step < 0 || invalidCorrection(correction)) throw new RewindError("invalid_input", 400);
  const text = correction.trim();

  const exported = await loadRunExport(database, ownerId, runId);
  if (!exported) throw new RewindError("run_not_found", 404);
  if (!verifyRunExport(exported).ok || !exported.seal) throw new RewindError("run_not_rewindable", 422);
  if (step > exported.seal.step_count) throw new RewindError("step_out_of_range", 400);

  const agentId = await runAgentId(database, ownerId, runId);
  if (!agentId) throw new RewindError("run_not_found", 404);

  const blobs = options.blobs ?? createBlobStore();
  const checkpoint = await loadCheckpoint(database, ownerId, runId, step, blobs);
  if (!checkpoint) throw new RewindError("checkpoint_missing", 409);
  // A partial row, a missing/altered state or manifest, or an unknown field all refuse before anything is touched.
  if (checkpoint.status !== "complete" || !checkpoint.stateFound || !checkpoint.state || !checkpoint.manifestFound) {
    throw new RewindError("checkpoint_incomplete", 422);
  }

  const task = correctionTask(checkpoint.state.task, text);
  const ports = options.ports ?? createChatRunPorts(database);
  const release = claimAgent(agentId);
  if (!release) throw new RewindError("agent_busy", 409);
  let handedOff = false;

  try {
    let prepared;
    try {
      prepared = await prepareChatRun(ports, ownerId, agentId, task, { branch: { runId, step } });
    } catch {
      throw new RewindError("service_unavailable", 503);
    }
    if (!prepared.ok) {
      throw prepared.reason === "no_signing_key" ? new RewindError("no_signing_key", 503)
        : prepared.reason === "no_model" ? new RewindError("no_model", 409)
          : new RewindError("agent_unavailable", 409);
    }
    const receipts = prepared.receipts;
    if (!receipts) throw new RewindError("service_unavailable", 503);
    const desktop = prepared.start.desktop;

    const status = await (options.status ?? ((id: string) => desktopSession(id, ownerId, "session.status")))(agentId).catch(() => null);
    if (status?.takenOver) throw new RewindError("takeover_active", 409);
    if (!status || status.state !== "running") throw new RewindError("agent_unavailable", 409);

    if (!desktop.checkpointManifest) throw new RewindError("checkpoint_incomplete", 422);
    let current;
    try { current = await desktop.checkpointManifest(); } catch { throw new RewindError("service_unavailable", 503); }

    const planned = planRestore(checkpoint.entries, current.entries);
    if (!planned.ok) throw new RewindError(planned.reason, 422);
    if (await preflightBlobs(blobs, planned.plan)) throw new RewindError("blob_missing", 422);

    let restored: RestoredCounts;
    try {
      restored = await applyRestore(desktop, blobs, planned.plan, receipts.runId);
    } catch (error) {
      if (error instanceof RestoreError) {
        throw new RewindError(error.code === "files_unsupported" ? "service_unavailable" : "restore_failed",
          error.code === "files_unsupported" ? 503 : 500, error.restored);
      }
      throw error;
    }

    const short = runId.slice(0, 8);
    await ports.postCard(ownerId, agentId, { type: "message",
      text: `Rewound to step ${step} of run ${short}. Continuing on a new branch with your correction. Earlier steps are not run again. Sent emails, orders and other external actions are not undone, and the browser page stays as it is now.` },
    receipts.runId).catch(() => undefined);

    const resume: RunResume = {
      // The stored state is validated and only shown to the model; its action field is the same closed set the loop writes.
      history: checkpoint.state.history.map((item) => ({ ...item, action: item.action as StepSummary["action"] })),
      documents: checkpoint.state.documents, delivered: checkpoint.state.delivered, turn: checkpoint.state.turn,
    };
    let settle!: (started: boolean) => void;
    const startPromise = new Promise<boolean>((resolve) => { settle = resolve; });
    let settled = false;
    const onStarted = () => { if (!settled) { settled = true; settle(true); } };

    handedOff = true;
    void Promise.resolve()
      .then(() => ports.run({
        agent: prepared.start.persona, task, provider: prepared.provider, model: prepared.start.model, hardModel: prepared.start.hardModel,
        samConfig: prepared.samConfig, desktop, skills: prepared.start.skills, timezone: prepared.start.timezone,
        receipts, costs: prepared.costs, evidence: prepared.start.evidence?.(), checkpoints: prepared.start.checkpoints?.(),
        resume, claimed: release, onStarted,
        canary: prepared.start.canary,
        onSecurityStop: prepared.start.onSecurityStop
          ? (event) => prepared.start.onSecurityStop!({ ...event, runId: receipts.runId })
          : undefined,
        postCard: (card) => ports.postCard(ownerId, agentId, card, receipts.runId),
        onFileDelivered: ports.fileDelivered ? (file) => ports.fileDelivered!(ownerId, agentId, file) : undefined,
      }))
      .then((result) => {
        if (!settled) { settled = true; settle(result.outcome !== "busy"); }
        if (result.outcome === "busy") release();
      })
      .catch(() => { if (!settled) { settled = true; settle(false); } release(); });

    const wait = options.waitForStartMs ?? 15_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = await Promise.race([
      startPromise,
      new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), wait); timer.unref?.(); }),
    ]);
    clearTimeout(timer);
    if (started === true) return { runId: receipts.runId, restored: { ...restored, kept: planned.plan.kept } };
    if (started === "timeout") return { runId: receipts.runId, restored: { ...restored, kept: planned.plan.kept }, starting: true };
    release();
    throw new RewindError("run_start_failed", 503);
  } catch (error) {
    if (!handedOff) release();
    if (error instanceof RewindError) throw error;
    throw new RewindError("service_unavailable", 503);
  }
}
