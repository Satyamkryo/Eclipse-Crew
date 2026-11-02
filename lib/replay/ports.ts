import "server-only";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { owner } from "../../db/schema";
import { getAgentRecord } from "../agents/data";
import { CHAT_RUN_TEXT } from "../agent/chat-run";
import { createDesktopPort, type DeliveredFile, type DesktopPort } from "../agent/desktop-port";
import type { RunCard } from "../agent/step-loop";
import { appendAgentCard, appendOutboxFiles } from "../chat/data";
import { syncAgentEgress } from "../egress/sync";
import { ensureSecurityLoops } from "../security/loops";
import { createCheckpointRecorder, type CheckpointSink } from "../checkpoints/store";
import { desktopSession } from "../desktop/client";
import { createEvidenceRecorder, type EvidenceSink } from "../receipts/evidence";
import type { ReceiptSink } from "../receipts/fields";
import { loadReceiptSigner } from "../receipts/signer";
import { createReceiptRecorder } from "../receipts/store";
import { registerRun } from "../jobs/control";
import { recordRunMeta } from "../jobs/meta";
import { startHeal } from "../heal/ports";
import type { HealScript } from "../heal/heal";
import { countUses, findGrant, recordUse } from "../approvals/store";
import type { ActionClass } from "../agent/risk";
import { runReplay, type ReplayDeps, type ReplayResult } from "./runner";
import type { StoredScript } from "./store";

type Database = Awaited<ReturnType<typeof getDatabase>>;

const BUSY_TEXT = "I am still working on another run. Start the replay again when I finish.";

// TASK-041. Everything a replay reads or writes outside the runner. Unlike a chat run it needs no model, provider or key:
// only an active agent, a running desktop and the receipt signing key.
export type ReplayStart =
  | { ok: true; persona: { id: string; name: string; actions: readonly string[] }; desktop: DesktopPort;
      receipts: (task: string) => ReceiptSink; evidence: () => EvidenceSink; checkpoints: () => CheckpointSink;
      approvals: (input: { actionClass: ActionClass; site: string | null }) => Promise<"allowed" | "approval_required"> }
  | { ok: false; reason: "unavailable" | "no_signing_key" | "crew_stopped" };

export interface ReplayRunMeta { trigger: "replay"; replayScriptId?: string; label?: string }

export interface ReplayPorts {
  prepare(ownerId: string, agentId: string, meta?: ReplayRunMeta): Promise<ReplayStart>;
  postCard(ownerId: string, agentId: string, card: RunCard, runId?: string): Promise<void>;
  fileDelivered?(ownerId: string, agentId: string, file: DeliveredFile, runId?: string): Promise<void>;
  // TASK-044. Called after an eligible mismatch; the replay lock is already released.
  heal?(ownerId: string, script: HealScript, result: ReplayResult, replayRunId: string | null): Promise<void>;
  run(deps: ReplayDeps): Promise<ReplayResult>;
}

export function createReplayPorts(database: Database): ReplayPorts {
  return {
    async prepare(ownerId, agentId, meta) {
      // TASK-052. Replays start through their own prepare, so the crew gate is checked here too.
      const owners = await database.select({ crewStoppedAt: owner.crewStoppedAt }).from(owner).where(eq(owner.id, ownerId)).limit(1);
      if (owners[0]?.crewStoppedAt) return { ok: false, reason: "crew_stopped" };
      const agent = await getAgentRecord(database, ownerId, agentId);
      if (!agent || agent.status !== "active") return { ok: false, reason: "unavailable" };
      try { await syncAgentEgress(database, ownerId, agentId); } catch { /* the proxy fails closed; the loop retries */ }
      ensureSecurityLoops();
      // No signing key, no run: a replay that cannot leave proof does not act.
      let signer;
      try { signer = loadReceiptSigner(); } catch { return { ok: false, reason: "no_signing_key" }; }
      const runId = randomUUID();
      let generation: string | undefined;
      try { generation = (await desktopSession(agentId, ownerId, "session.start")).generation; } catch { /* reported below */ }
      if (!generation) return { ok: false, reason: "unavailable" };
      const desktop = createDesktopPort(agentId, ownerId, generation);
      return {
        ok: true, persona: { id: agent.id, name: agent.name, actions: agent.actions }, desktop,
        receipts: (task) => createReceiptRecorder({ database, ownerId, agentId, agentName: agent.name, task, signer, runId,
          ...(meta ? { onBegin: async () => { await recordRunMeta(database, { runId, ownerId, agentId, ...meta }); } } : {}) }),
        evidence: () => createEvidenceRecorder({ database, ownerId, runId }),
        checkpoints: () => createCheckpointRecorder({ database, ownerId, runId, desktop }),
        // TASK-050. Replay never prompts: only a live grant with capacity in the last 24 hours lets a risky step run.
        approvals: async ({ actionClass, site }) => {
          if (!site) return "approval_required";
          const grant = await findGrant(database, ownerId, agentId, site, actionClass);
          if (!grant) return "approval_required";
          const used = await countUses(database, ownerId, grant.id, new Date(Date.now() - 24 * 60 * 60_000));
          if (used >= grant.maxPerDay) return "approval_required";
          await recordUse(database, ownerId, grant.id, runId);
          return "allowed";
        },
      };
    },
    async postCard(ownerId, agentId, card, runId) {
      await appendAgentCard(database, ownerId, agentId, { card, sourceTag: "agent", ...(runId ? { runId } : {}) });
    },
    async fileDelivered(ownerId, agentId, file, runId) { await appendOutboxFiles(database, ownerId, agentId, [file], runId); },
    heal: (ownerId, script, result, replayRunId) => startHeal(database, ownerId, script, result, replayRunId),
    run: runReplay,
  };
}

// Replays one saved script and ends with exactly one card. Never throws. `inputs` are the owner's text for `type` steps.
export async function runSavedReplay(
  ownerId: string, script: Pick<StoredScript, "agentId" | "name" | "steps"> & { id?: string; version?: number },
  inputs: ReadonlyMap<number, string>, ports: ReplayPorts,
): Promise<"started" | "busy" | "unavailable" | "no_signing_key" | "crew_stopped" | "failed"> {
  const say = async (message: string) => {
    try { await ports.postCard(ownerId, script.agentId, { type: "message", text: message }); } catch { /* nothing more to report to */ }
  };
  let control: ReturnType<typeof registerRun> | null = null;
  try {
    const start = await ports.prepare(ownerId, script.agentId, {
      trigger: "replay", ...(script.id ? { replayScriptId: script.id } : {}), label: `Replay: ${script.name}`,
    });
    if (!start.ok) { await say(CHAT_RUN_TEXT[start.reason]); return start.reason; }
    const receipts = start.receipts(`Replay: ${script.name}`);
    control = registerRun(receipts.runId, ownerId, script.agentId);
    const result = await ports.run({
      agent: start.persona, script, inputs, desktop: start.desktop, receipts, evidence: start.evidence(), checkpoints: start.checkpoints(),
      approvals: start.approvals ? (request) => start.approvals(request) : undefined,
      signal: control.signal,
      postCard: (card) => ports.postCard(ownerId, script.agentId, card, receipts.runId),
      onFileDelivered: ports.fileDelivered ? (file) => ports.fileDelivered!(ownerId, script.agentId, file, receipts.runId) : undefined,
    });
    control.done();
    if (result.outcome === "busy") { await say(BUSY_TEXT); return "busy"; }
    // TASK-044. The runner has released the agent lock; the repair claims it again. A missing id/version (tests or an older
    // caller) simply means no repair is attempted.
    if (ports.heal && script.id && script.version !== undefined && result.outcome === "needs_owner" && result.stoppedAt) {
      await ports.heal(
        ownerId,
        { id: script.id, agentId: script.agentId, name: script.name, steps: script.steps, version: script.version },
        result,
        receipts.runId ?? null,
      ).catch(() => undefined);
    }
    return "started";
  } catch {
    await say(CHAT_RUN_TEXT.unavailable);
    return "failed";
  } finally {
    control?.done();
  }
}

// Fire-and-forget entry for the run route. The route has already checked the script, the inputs and the agent.
export function startReplay(database: Database, ownerId: string, script: StoredScript, inputs: ReadonlyMap<number, string>): void {
  void runSavedReplay(ownerId, script, inputs, createReplayPorts(database)).catch(() => undefined);
}
