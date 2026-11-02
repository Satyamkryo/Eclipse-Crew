import "server-only";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDatabase } from "../../db/client";
import { owner } from "../../db/schema";
import { getAgentRecord } from "../agents/data";
import { appendAgentCard, appendOutboxFiles } from "../chat/data";
import { syncAgentEgress } from "../egress/sync";
import { ensureSecurityLoops } from "../security/loops";
import { desktopSession } from "../desktop/client";
import { createModelSettingsStore } from "../models/data";
import { proxyTransportFor } from "../models/transport";
import { createProviderConnector } from "../providers";
import type { ProviderConnector, ProviderTransport } from "../providers/types";
import { createEvidenceRecorder, type EvidenceSink } from "../receipts/evidence";
import { createCheckpointRecorder, type CheckpointSink } from "../checkpoints/store";
import type { ReceiptSink } from "../receipts/fields";
import { loadReceiptSigner } from "../receipts/signer";
import { createReceiptRecorder } from "../receipts/store";
import { createCostedConnector } from "../costs/runtime";
import { clearAgentAttention, createRunCostSink, setApprovalAttention } from "../costs/store";
import { createApprovalGate } from "../approvals/gate";
import type { ApprovalGate } from "../approvals/types";
import { recordScopeBlocked } from "../security/events";
import type { ScopeRule } from "./scope";
import type { BudgetCard, RunCostSink } from "../costs/types";
import { registerRun } from "../jobs/control";
import { recordRunMeta } from "../jobs/meta";
import { ensureCanary } from "../security/canary-store";
import { createTripwirePorts, isTripped, triggerTripwire } from "../security/tripwire";
import { listApprovedSkills } from "../skills/store";
import { resolveTimezone } from "../time/clock";
import type { AgentPersona, AgentSkill } from "./context";
import { createDesktopPort, type DeliveredFile, type DesktopPort } from "./desktop-port";
import { runTask, type RunCard, type RunDeps, type RunOutcome, type SecurityStopResult, type SecurityStopSignal } from "./step-loop";

type Database = Awaited<ReturnType<typeof getDatabase>>;

// Fixed owner-facing texts. Provider and desktop error details never reach the chat.
export const CHAT_RUN_TEXT = {
  busy: "I am still working on your last message. Send this again when I finish.",
  no_model: "I cannot answer yet. Save a Main AI model and key in Settings -> Models, then send your message again.",
  unavailable: "I could not start. Check that my desktop is running and try again.",
  no_signing_key: "I cannot run yet because receipt signing is not set up, and I do not act without proof. Run `npm run receipt-key`, then `docker compose up -d`, and send your message again.",
} as const;

// TASK-042. How this run was started, for the Jobs dashboard. The signed header stays untouched.
export interface ChatRunMeta {
  trigger: "chat" | "run_now" | "schedule" | "branch" | "heal";
  routineId?: string;
  executionId?: string;
  retryOf?: string;
  label?: string;
}

export interface ChatRunPrepareOptions {
  // TASK-043: the new run is a branch of `runId` from checkpoint `step`.
  branch?: { runId: string; step: number };
  // TASK-042: display metadata recorded once the run row exists.
  meta?: ChatRunMeta;
}

export type ChatRunStart =
  | { ok: true; persona: AgentPersona & { id: string }; timezone: string; provider: ProviderConnector; model: string; hardModel: string | null;
      skills?: AgentSkill[];
      providerInfo?: { providerId: string; kind: "meta" | "openai-compatible"; baseUrl: string | null };
      samProvider?: { providerId: string; kind: "meta" | "openai-compatible"; baseUrl: string | null };
      samConfig?: { state: "off" | "on" | "unavailable"; transport?: ProviderTransport; provider?: { providerId: string; kind: "meta" | "openai-compatible"; baseUrl: string | null } };
      desktop: DesktopPort;
      // Proof receipts for this run (TASK-029). Production always provides them; a port without them runs unsigned (tests only).
      receipts?: (task: string) => ReceiptSink;
      // Screenshot evidence for the History view (TASK-031), tied to the same run id as the receipts.
      evidence?: () => EvidenceSink;
      // Per-step state and file checkpoints (TASK-032), tied to the same run id.
      checkpoints?: () => CheckpointSink;
      // TASK-034. Production always supplies the ledger; tests may omit it.
      costs?: (onWarning: (card: BudgetCard) => Promise<void>) => RunCostSink;
      // TASK-047. The bait secret and the tripwire hook stay server-side.
      canary?: string | null;
      onSecurityStop?: (event: SecurityStopSignal & { runId?: string }) => Promise<SecurityStopResult>;
      // TASK-049. The owner-configured site allowlist and the security-event writer.
      allowedHosts?: readonly string[];
      onScopeBlocked?: (rule: ScopeRule, runId?: string) => void | Promise<void>;
      // TASK-050. Risky clicks wait for the owner or a scoped grant.
      approvals?: ApprovalGate; }
  | { ok: false; reason: "no_model" | "unavailable" | "no_signing_key" };

// Everything a chat run reads or writes outside the step loop. Tests replace these; production uses the database,
// the model settings store, the egress-proxy transport and the desktop controller.
export interface ChatRunPorts {
  prepare(ownerId: string, agentId: string, options?: ChatRunPrepareOptions): Promise<ChatRunStart>;
  postCard(ownerId: string, agentId: string, card: RunCard, runId?: string): Promise<void>;
  // A file the agent just delivered to outbox/ gets its card at once (the chat poll would find it later anyway).
  fileDelivered?(ownerId: string, agentId: string, file: DeliveredFile, runId?: string): Promise<void>;
  run(deps: RunDeps): Promise<{ outcome: RunOutcome; cardPosted: boolean }>;
}

export function createChatRunPorts(database: Database): ChatRunPorts {
  return {
    async prepare(ownerId, agentId, options) {
      const agent = await getAgentRecord(database, ownerId, agentId);
      if (!agent || agent.status !== "active") return { ok: false, reason: "unavailable" };
      try { await syncAgentEgress(database, ownerId, agentId); } catch { /* the proxy fails closed; the loop retries */ }
      ensureSecurityLoops();

      const settings = await createModelSettingsStore(database).load(ownerId);
      const main = settings.main;
      const provider = main?.mode === "active" ? main.provider : null;
      if (!main || !provider || !main.model || !provider.encryptedKey) return { ok: false, reason: "no_model" };
      const transport = proxyTransportFor(provider);
      if (!transport) return { ok: false, reason: "no_model" };
      let connector: ProviderConnector;
      try {
        connector = createProviderConnector(provider.kind === "meta"
          ? { kind: "meta", transport }
          : { kind: "openai-compatible", baseUrl: provider.baseUrl ?? "", transport });
      } catch { return { ok: false, reason: "no_model" }; }

      // No signing key, no run: an agent that cannot leave proof does not act.
      let signer;
      try { signer = loadReceiptSigner(); } catch { return { ok: false, reason: "no_signing_key" }; }

      // TASK-047. A run that cannot be checked for its canary does not start.
      let canary: string | null = null;
      try { canary = (await ensureCanary(database, ownerId, agentId)).canary; } catch { return { ok: false, reason: "unavailable" }; }
      const runId = randomUUID();

      const rows = await database.select({ timezone: owner.timezone }).from(owner).where(eq(owner.id, ownerId)).limit(1);
      const timezone = resolveTimezone(rows[0]?.timezone) ?? "UTC";

      let generation: string | undefined;
      try { generation = (await desktopSession(agentId, ownerId, "session.start")).generation; } catch { /* reported below */ }
      if (!generation) return { ok: false, reason: "unavailable" };
      const desktop = createDesktopPort(agentId, ownerId, generation);

      const sam = settings.sam;
      const samProvider = sam?.useMainKey ? provider : sam?.provider;
      const samTransport = sam?.mode === "meta" && samProvider?.kind === "meta" ? proxyTransportFor(samProvider) : null;
      const providerInfo = { providerId: provider.id, kind: provider.kind, baseUrl: provider.baseUrl };
      const samProviderInfo = samProvider ? { providerId: samProvider.id, kind: samProvider.kind, baseUrl: samProvider.baseUrl } : undefined;
      const samConfig = {
        state: (sam?.mode === "meta" ? samTransport ? "on" : "unavailable" : "off") as "off" | "on" | "unavailable",
        ...(samTransport ? { transport: samTransport } : {}),
        ...(samProviderInfo ? { provider: samProviderInfo } : {}),
      };
      let approvedSkills: AgentSkill[] = [];
      try { approvedSkills = await listApprovedSkills(database, ownerId, agentId); } catch { approvedSkills = []; }
      const meta: ChatRunMeta = options?.meta ?? (options?.branch ? { trigger: "branch" } : { trigger: "chat" });
      const onSecurityStop = async (event: SecurityStopSignal & { runId?: string }): Promise<SecurityStopResult> => {
        if (event.cause === "cancelled") return isTripped(ownerId, agentId) ? "duplicate" : "failed";
        const sourceRef = `typed_text:${event.runId ?? `${agentId}:${randomUUID()}`}:${event.step}`;
        const result = await triggerTripwire(createTripwirePorts(database), {
          ownerId, agentId, source: "typed_text", runId: event.runId ?? null, sourceRef,
        });
        return result.duplicate ? "duplicate" : result.cardPosted ? "posted" : "failed";
      };
      const approvals = createApprovalGate({
        database, ownerId,
        postCard: async (card) => { await appendAgentCard(database, ownerId, agentId, { card, sourceTag: "agent", runId }); },
        setAttention: () => setApprovalAttention(database, ownerId, agentId),
        clearAttention: () => clearAgentAttention(database, ownerId, agentId, "approval_pending"),
      });
      return {
        samConfig, providerInfo, ...(samProviderInfo ? { samProvider: samProviderInfo } : {}),
        ok: true, provider: connector, model: main.model, hardModel: main.routing === "auto" ? main.hardModel : null, timezone, skills: approvedSkills,
        persona: { id: agent.id, name: agent.name, role: agent.role, soulMd: agent.soulMd, actions: agent.actions },
        desktop, canary, onSecurityStop, approvals, allowedHosts: agent.domains,
        onScopeBlocked: (rule, blockedRunId) => recordScopeBlocked(database, ownerId, agentId, blockedRunId ?? runId, rule),
        receipts: (task) => createReceiptRecorder({ database, ownerId, agentId, agentName: agent.name, task, signer, runId,
          ...(options?.branch ? { branch: options.branch } : {}),
          onBegin: async () => { await recordRunMeta(database, { runId, ownerId, agentId, ...meta }); } }),
        evidence: () => createEvidenceRecorder({ database, ownerId, runId }),
        checkpoints: () => createCheckpointRecorder({ database, ownerId, runId, desktop }),
        costs: (onWarning) => createRunCostSink({ database, ownerId, agentId, runId, onWarning }),
      };
    },
    async postCard(ownerId, agentId, card, runId) {
      await appendAgentCard(database, ownerId, agentId, { card, sourceTag: "agent", ...(runId ? { runId } : {}) });
    },
    async fileDelivered(ownerId, agentId, file, runId) { await appendOutboxFiles(database, ownerId, agentId, [file], runId); },
    run: runTask,
  };
}

export interface PreparedChatRun {
  start: Extract<ChatRunStart, { ok: true }>;
  receipts: ReceiptSink | undefined;
  costs: RunCostSink | undefined;
  provider: ProviderConnector;
  samConfig: RunDeps["samConfig"];
}

// Everything a run needs once the agent, model, key and desktop are ready. A chat message uses it directly; a rewind branch
// (TASK-043) uses it with the branch header and a resumed task.
export async function prepareChatRun(
  ports: ChatRunPorts, ownerId: string, agentId: string, text: string, options?: ChatRunPrepareOptions,
): Promise<{ ok: false; reason: "no_model" | "unavailable" | "no_signing_key" } | ({ ok: true } & PreparedChatRun)> {
  const start = await ports.prepare(ownerId, agentId, options);
  if (!start.ok) return start;
  const receipts = start.receipts?.(text);
  const costs = start.costs?.((card) => ports.postCard(ownerId, agentId, card, receipts?.runId));
  const provider = costs && start.providerInfo
    ? createCostedConnector(start.provider, costs, start.providerInfo)
    : start.provider;
  const samConfig = costs && start.samConfig && start.samProvider
    ? { ...start.samConfig, provider: start.samProvider }
    : start.samConfig;
  return { ok: true, start, receipts, costs, provider, samConfig };
}

// Runs one task for a chat message and ends with exactly one card. Never throws.
export async function runChatMessage(
  ownerId: string, agentId: string, text: string, ports: ChatRunPorts, meta?: ChatRunMeta,
): Promise<"started" | "busy" | "no_model" | "unavailable" | "no_signing_key" | "failed"> {
  const say = async (message: string) => {
    try { await ports.postCard(ownerId, agentId, { type: "message", text: message }); } catch { /* nothing more to report to */ }
  };
  let control: ReturnType<typeof registerRun> | null = null;
  try {
    const prepared = await prepareChatRun(ports, ownerId, agentId, text, meta ? { meta } : undefined);
    if (!prepared.ok) { await say(CHAT_RUN_TEXT[prepared.reason]); return prepared.reason; }
    const { start, receipts, costs, provider, samConfig } = prepared;
    if (receipts?.runId) control = registerRun(receipts.runId, ownerId, agentId);
    const result = await ports.run({
      receipts, costs, evidence: start.evidence?.(), checkpoints: start.checkpoints?.(),
      agent: start.persona, task: text, provider, model: start.model, hardModel: start.hardModel, samConfig, desktop: start.desktop,
      skills: start.skills, timezone: start.timezone, ...(control ? { signal: control.signal } : {}),
      canary: start.canary, approvals: start.approvals, allowedHosts: start.allowedHosts, onScopeBlocked: start.onScopeBlocked,
      onSecurityStop: start.onSecurityStop
        ? (event) => start.onSecurityStop!({ ...event, runId: receipts?.runId })
        : undefined,
      postCard: (card) => ports.postCard(ownerId, agentId, card, receipts?.runId),
      onFileDelivered: ports.fileDelivered ? (file) => ports.fileDelivered!(ownerId, agentId, file, receipts?.runId) : undefined,
    });
    if (result.outcome === "busy") { await say(CHAT_RUN_TEXT.busy); return "busy"; }
    return "started";
  } catch {
    await say(CHAT_RUN_TEXT.unavailable);
    return "failed";
  } finally {
    control?.done();
  }
}

// Fire-and-forget entry for the messages route. The POST has already stored the message and returns without waiting.
export function startChatRun(database: Database, ownerId: string, agentId: string, text: string, meta?: ChatRunMeta): void {
  void runChatMessage(ownerId, agentId, text, createChatRunPorts(database), meta).catch(() => undefined);
}
