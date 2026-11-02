import "server-only";

import type { getDatabase } from "../../db/client";
import type { ChatRunStart } from "../agent/chat-run";
import type { DeliveredFile } from "../agent/desktop-port";
import type { RunDeps, RunResult } from "../agent/step-loop";
import type { ChatCard } from "../chat/schema";
import { createCostedConnector } from "../costs/runtime";
import { verifyRunExport, type RunExport } from "../receipts/chain.mjs";
import { affectedCount, diffSteps } from "../replay/diff";
import type { ReplayResult } from "../replay/runner";
import { MAX_REPLAY_STEPS, compileFromReceipts, replayStepsSchema } from "../replay/script";
import { getScript, type StoredScript } from "../replay/store";
import { isHealFailureCode, type HealFailureCode } from "./codes";
import { createProposal, hasPendingProposal } from "./store";
import { buildHealTask } from "./task";
import { skillUpdateCard } from "./view";

type Database = Awaited<ReturnType<typeof getDatabase>>;

// TASK-044. What a repair needs from the world outside it, so the trigger, the run and the proposal can be tested without a
// real desktop or model. Production wiring is in lib/heal/ports.ts.
export type HealScript = Pick<StoredScript, "id" | "agentId" | "name" | "steps" | "version">;

export interface HealPorts {
  prepare(ownerId: string, agentId: string): Promise<ChatRunStart>;
  run(deps: RunDeps): Promise<RunResult>;
  loadExport(ownerId: string, runId: string): Promise<RunExport | null>;
  postCard(ownerId: string, agentId: string, card: ChatCard, runId?: string): Promise<void>;
  fileDelivered?(ownerId: string, agentId: string, file: DeliveredFile): Promise<void>;
}

export type HealOutcome =
  | "not_healable" | "missing" | "stale" | "typed_step" | "pending" | "invalid_step" | "too_long"
  | "no_model" | "unavailable" | "no_signing_key" | "busy" | "not_finished" | "unverified"
  | "uncompilable" | "invalid" | "conflict" | "proposed";

const TEXT = {
  no_model: "The page changed, but I need a saved Main AI model to find the new steps. Save one in Settings → Models, then replay again.",
  typed_step: "I can't repair this automatically because a later step types text that was never saved. Take over or run the task again.",
  too_long: "I finished the task, but the repair would make the replay longer than 20 steps. The saved replay is unchanged.",
  unverified: "I finished the task, but I couldn't verify the repair's proof, so I didn't change the saved replay.",
  uncompilable: "I finished the task, but the repair can't be saved as a replay (for example, a step's result can only be judged by a model). The saved replay is unchanged.",
  stale: "The saved replay changed while I was repairing it. Run it again to propose a new update.",
} as const;

// Runs only after the replay gave its agent lock back. Returns a fixed outcome for the caller and tests; never throws on a
// model or desktop failure (the repair run posts its own card).
export async function maybeHeal(
  database: Database, ownerId: string, script: HealScript, result: ReplayResult, replayRunId: string | null, ports: HealPorts,
): Promise<HealOutcome> {
  const stopped = result.stoppedAt;
  if (!stopped) return "not_healable";
  const code = stopped.code;
  if (!isHealFailureCode(code)) return "not_healable";
  if (!replayRunId) return "unverified";

  // The script may have been edited (approved) or deleted while the replay ran.
  const current = await getScript(database, ownerId, script.id);
  if (!current) return "missing";
  if (current.version !== script.version) return "stale";

  const task = buildHealTask(current.name, current.steps, stopped.step);
  if (!task.ok) {
    if (task.code === "typed_step") await say(ports, ownerId, script.agentId, TEXT.typed_step);
    if (task.code === "too_long") await say(ports, ownerId, script.agentId, TEXT.too_long);
    return task.code;
  }
  if (await hasPendingProposal(database, ownerId, script.id)) return "pending";

  const prepared = await ports.prepare(ownerId, script.agentId);
  if (!prepared.ok) {
    if (prepared.reason === "no_model") await say(ports, ownerId, script.agentId, TEXT.no_model);
    return prepared.reason;
  }
  const receipts = prepared.receipts?.(task.task);
  if (!receipts) return "unverified";

  const costs = prepared.costs?.((card) => ports.postCard(ownerId, script.agentId, card, receipts.runId));
  const provider = costs && prepared.providerInfo ? createCostedConnector(prepared.provider, costs, prepared.providerInfo) : prepared.provider;
  const samConfig = costs && prepared.samConfig && prepared.samProvider
    ? { ...prepared.samConfig, provider: prepared.samProvider }
    : prepared.samConfig;

  const run = await ports.run({
    agent: prepared.persona, task: task.task, provider, model: prepared.model, hardModel: prepared.hardModel, samConfig,
    desktop: prepared.desktop, skills: prepared.skills, timezone: prepared.timezone,
    receipts, evidence: prepared.evidence?.(), checkpoints: prepared.checkpoints?.(), costs,
    canary: prepared.canary,
    onSecurityStop: prepared.onSecurityStop
      ? (event) => prepared.onSecurityStop!({ ...event, runId: receipts.runId })
      : undefined,
    untrustedContext: task.data,
    postCard: (card) => ports.postCard(ownerId, script.agentId, card, receipts.runId),
    onFileDelivered: ports.fileDelivered ? (file) => ports.fileDelivered!(ownerId, script.agentId, file) : undefined,
    maxSteps: 8, maxTokens: 100_000, maxWallClockMs: 5 * 60_000,
  });
  if (run.outcome === "busy") return "busy";
  if (run.outcome !== "finished") return "not_finished";

  const exported = await ports.loadExport(ownerId, receipts.runId);
  if (!exported || !verifyRunExport(exported).ok) {
    await say(ports, ownerId, script.agentId, TEXT.unverified);
    return "unverified";
  }
  const compiled = compileFromReceipts(exported.steps.map((step) => ({ idx: step.idx, receipt: step.receipt })));
  if (!compiled.ok || compiled.steps.length === 0) {
    await say(ports, ownerId, script.agentId, TEXT.uncompilable);
    return "uncompilable";
  }

  const proposed = [...current.steps.slice(0, stopped.step - 1), ...compiled.steps]
    .map((step, index) => ({ ...step, idx: index + 1 }));
  if (proposed.length > MAX_REPLAY_STEPS) {
    await say(ports, ownerId, script.agentId, TEXT.too_long);
    return "too_long";
  }
  const parsed = replayStepsSchema.safeParse(proposed);
  if (!parsed.success) {
    await say(ports, ownerId, script.agentId, TEXT.uncompilable);
    return "uncompilable";
  }

  const created = await createProposal(database, {
    ownerId, agentId: script.agentId, scriptId: script.id, baseVersion: current.version,
    failedStep: stopped.step, failureCode: code as HealFailureCode, replayRunId, healRunId: receipts.runId, steps: parsed.data,
  });
  if (!created.ok) {
    if (created.error === "stale") await say(ports, ownerId, script.agentId, TEXT.stale);
    return created.error;
  }

  const changedSteps = affectedCount(diffSteps(current.steps, parsed.data));
  await ports.postCard(ownerId, script.agentId, skillUpdateCard({
    proposalId: created.proposal.id, scriptName: current.name, fromVersion: current.version,
    toVersion: created.proposal.proposedVersion, failedStep: stopped.step, changedSteps, failureCode: code as HealFailureCode,
  }), receipts.runId);
  return "proposed";
}

async function say(ports: HealPorts, ownerId: string, agentId: string, text: string): Promise<void> {
  await ports.postCard(ownerId, agentId, { type: "message", text }).catch(() => undefined);
}
