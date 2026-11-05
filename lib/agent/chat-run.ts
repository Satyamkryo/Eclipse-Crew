import "server-only";
import { defaultInstructions } from "../agents/schema";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDatabase } from "../../db/client";
import { agents, owner, runs } from "../../db/schema";
import { readBudgetStatus } from "../costs/store";
import { getAgentRecord } from "../agents/data";
import { appendAgentCard, appendOutboxFiles } from "../chat/data";
import { syncAgentEgress } from "../egress/sync";
import { ensureSecurityLoops } from "../security/loops";
import { createModelSettingsStore } from "../models/data";
import { connectorForProvider, isLocalProvider, proxyTransportFor } from "../models/transport";
import { joinProviderUrl } from "../providers/transport";
import type { ProviderConnector, ProviderContent, ProviderTransport } from "../providers/types";
import { createEvidenceRecorder, type EvidenceSink } from "../receipts/evidence";
import { createCheckpointRecorder, type CheckpointSink } from "../checkpoints/store";
import { listComposioAccounts } from "../composio/data";
import { createSubagentManager, type SubagentManager } from "./subagents";
import type { ReceiptSink } from "../receipts/fields";
import { loadReceiptSigner } from "../receipts/signer";
import { createReceiptRecorder } from "../receipts/store";
import { createCostedConnector } from "../costs/runtime";
import { createRunCostSink } from "../costs/store";
import { createApprovalGate } from "../approvals/gate";
import { refreshApprovalAttention } from "../approvals/attention";
import type { ApprovalGate } from "../approvals/types";
import { recordScopeBlocked } from "../security/events";
import type { ScopeRule } from "./scope";
import type { BudgetCard, RunCostSink } from "../costs/types";
import { registerRun } from "../jobs/control";
import { recordRunMeta } from "../jobs/meta";
import { ensureCanary } from "../security/canary-store";
import { createTripwirePorts, isTripped, triggerTripwire } from "../security/tripwire";
import { listApprovedSkills } from "../skills/store";
import { loadMemorySnapshot } from "../memory/snapshot";
import { resolveTimezone } from "../time/clock";
import { catalogEntry, MAX_CATALOG_TOOLS, type AgentPersona, type AgentSkill, type ToolCatalogEntry } from "./context";
import { listMcpServers } from "../mcp/data";
import { createLazyDesktopPort, type DeliveredFile, type DesktopPort } from "./desktop-port";
import { createAgentLifecycle, DesktopLifecycleError } from "./runtime";
import { runTask, type MemoryPort, type RunCard, type RunDeps, type RunOutcome, type SecurityStopResult, type SecurityStopSignal } from "./step-loop";
import { proposeMemory } from "../memory/changes";
import { enqueueMemoryReview } from "../memory/queue";
import { searchHistory } from "../chat/search";
import { COMPOSIO_AGENT_KEY, createToolPort, type ToolPort } from "../tools/port";
import { createShellPort, type ShellPort } from "./shell-port";
import { createAudioPort, type AudioPort } from "./audio-port";
import { loadConversation } from "./conversation";
import { startHeartbeat } from "../runs/heartbeat";
import { loadTeammates, performHandoff } from "./handoff";

type Database = Awaited<ReturnType<typeof getDatabase>>;

// Fixed owner-facing texts. Provider and desktop error details never reach the chat.
export const CHAT_RUN_TEXT = {
  busy: "I am still working on your last message. Send this again when I finish.",
  no_model: "I cannot answer yet. Save a Main AI model and key in Settings -> Models, then send your message again.",
  unavailable: "I could not start. Check that the desktop service is running and try again.",
  no_signing_key: "I cannot run yet because receipt signing is not set up, and I do not act without proof. Run `npm run receipt-key`, then `docker compose up -d`, and send your message again.",
  crew_stopped: "The crew is stopped. Resume the crew in the Security Center.",
} as const;

// TASK-042. How this run was started, for the Jobs dashboard. The signed header stays untouched.
export interface ChatRunMeta {
  trigger: "chat" | "run_now" | "schedule" | "branch" | "heal" | "handoff";
  routineId?: string;
  executionId?: string;
  retryOf?: string;
  label?: string;
  // TASK-085: the sender run when this run answers a teammate handoff.
  handoffOf?: string;
}

export interface ChatRunPrepareOptions {
  // TASK-043: the new run is a branch of `runId` from checkpoint `step`.
  branch?: { runId: string; step: number };
  // TASK-042: display metadata recorded once the run row exists.
  meta?: ChatRunMeta;
  // TASK-083: the stored owner message, excluded from the earlier-conversation block.
  messageId?: string;
  // TASK-085: the receiver's note from the sender (data, tagged `agent`), and the sender run in the signed header.
  handoffNote?: { sender: string; text: string };
  handoffOf?: string;
  // The task text for this run. Filled by prepareChatRun; handoff reads it to match the stored owner message.
  taskText?: string;
}

export type ChatRunStart =
  | { ok: true; persona: AgentPersona & { id: string }; timezone: string; provider: ProviderConnector; model: string; hardModel: string | null;
      skills?: AgentSkill[];
      // TASK-085. Handoff execution and the receiver's note; teammates are offered only with the permission.
      handoff?: (input: { agent: string; note: string }) => Promise<{ ok: true; receiverName: string } | { ok: false; code: string }>;
      handoffNote?: { sender: string; text: string };
      teammates?: { name: string; role: string; status: "active" | "paused"; tools: readonly string[] }[];
      sourceMessageId?: string;
      // TASK-076. The screenless tools this run may grant, and the manager that runs its helpers.
      helperTools?: readonly string[];
      subagents?: SubagentManager;
      providerInfo?: { providerId: string; kind: "meta" | "openai-compatible"; baseUrl: string | null };
      samProvider?: { providerId: string; kind: "meta" | "openai-compatible"; baseUrl: string | null };
      samConfig?: { state: "off" | "on" | "unavailable"; transport?: ProviderTransport; endpoint?: string; provider?: { providerId: string; kind: "meta" | "openai-compatible"; baseUrl: string | null } };
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
      anyPublicWeb?: boolean;
      onScopeBlocked?: (rule: ScopeRule, runId?: string) => void | Promise<void>;
      // TASK-050. Risky clicks wait for the owner or a scoped grant.
      approvals?: ApprovalGate;
      // TASK-051. This agent's Astra Mode setting, read once when the run starts.
      astra: boolean;
      // TASK-054. Add-only memory requests bound to this run.
      memory?: MemoryPort;
      // TASK-072. Pinned remote tool calls.
      tools?: ToolPort;
      // TASK-073. Shell commands in the agent namespace.
      shell?: ShellPort;
      // TASK-079. Bounded hearing through this agent's private speaker.
      audio?: (costs: RunCostSink | undefined) => AudioPort;
      // TASK-083. Earlier owner/agent turns and the owner texts they contain (scope only).
      conversation?: ProviderContent[];
      scopeTexts?: readonly string[];
      // ADR-040. Names and short descriptions of the tools this run may call (untrusted server text).
      toolCatalog?: ToolCatalogEntry[]; }
  | { ok: false; reason: "no_model" | "unavailable" | "no_signing_key" | "crew_stopped" };

// Everything a chat run reads or writes outside the step loop. Tests replace these; production uses the database,
// the model settings store, the egress-proxy transport and the desktop controller.
export interface ChatRunPorts {
  prepare(ownerId: string, agentId: string, options?: ChatRunPrepareOptions): Promise<ChatRunStart>;
  postCard(ownerId: string, agentId: string, card: RunCard, runId?: string): Promise<void>;
  // A file the agent just delivered to outbox/ gets its card at once (the chat poll would find it later anyway).
  fileDelivered?(ownerId: string, agentId: string, file: DeliveredFile, runId?: string): Promise<void>;
  // TASK-085. Starts a 15 s heartbeat for a live run; the returned function stops it.
  heartbeat?(ownerId: string, runId: string, onCancel: () => void, onSealed: () => void): () => void;
  run(deps: RunDeps): Promise<{ outcome: RunOutcome; cardPosted: boolean }>;
}

export function createChatRunPorts(database: Database): ChatRunPorts {
  return {
    async prepare(ownerId, agentId, options) {
      // TASK-052. Stop crew sets the gate before halting anything; no run may prepare while it is set.
      const ownerRows = await database.select({ timezone: owner.timezone, crewStoppedAt: owner.crewStoppedAt })
        .from(owner).where(eq(owner.id, ownerId)).limit(1);
      if (ownerRows[0]?.crewStoppedAt) return { ok: false, reason: "crew_stopped" };
      const loaded = await getAgentRecord(database, ownerId, agentId);
      if (!loaded || loaded.status !== "active") return { ok: false, reason: "unavailable" };
      // ADR-040. A blank Tools list means every pinned MCP server and active Composio account connected to this agent,
      // and tool_call is then offered whenever one exists. Servers are already connected per agent; approvals,
      // risk classes, scope and the canary still apply to every call.
      const toolCatalog: ToolCatalogEntry[] = [];
      const connectedKeys: string[] = [];
      try {
        for (const server of await listMcpServers(database, ownerId, agentId)) {
          if (server.status !== "pinned") continue;
          connectedKeys.push(server.key);
          for (const tool of server.tools) toolCatalog.push(catalogEntry(`${server.key}.${tool.name}`, tool.description, tool.inputSchema));
        }
      } catch { /* no server list is simply no MCP tool */ }
      try {
        for (const account of await listComposioAccounts(database, ownerId, agentId)) {
          if (account.status !== "active") continue;
          if (!connectedKeys.includes(COMPOSIO_AGENT_KEY)) connectedKeys.push(COMPOSIO_AGENT_KEY);
          for (const tool of account.tools) toolCatalog.push(catalogEntry(`${COMPOSIO_AGENT_KEY}.${tool.slug}`, tool.description));
        }
      } catch { /* no Composio account is simply no extra tool */ }
      const grantedTools = loaded.tools.length ? loaded.tools : connectedKeys;
      const agent = {
        ...loaded, tools: grantedTools,
        actions: !loaded.tools.length && connectedKeys.length && !loaded.actions.includes("tool_call") ? [...loaded.actions, "tool_call"] : loaded.actions,
      };
      const visibleCatalog = toolCatalog.filter((entry) => grantedTools.includes(entry.name.split(".")[0])).slice(0, MAX_CATALOG_TOOLS);
      try { await syncAgentEgress(database, ownerId, agentId); } catch { /* the proxy fails closed; the loop retries */ }
      ensureSecurityLoops();

      const settings = await createModelSettingsStore(database).load(ownerId);
      const main = settings.main;
      const provider = main?.mode === "active" ? main.provider : null;
      // Hosted providers need a saved key; a local server (Ollama, LM Studio, llama.cpp, vLLM) may run without one.
      if (!main || !provider || !main.model || (!provider.encryptedKey && !isLocalProvider(provider))) return { ok: false, reason: "no_model" };
      const transport = proxyTransportFor(provider);
      if (!transport) return { ok: false, reason: "no_model" };
      let connector: ProviderConnector;
      try {
        connector = connectorForProvider(provider, transport);
      } catch { return { ok: false, reason: "no_model" }; }

      // No signing key, no run: an agent that cannot leave proof does not act.
      let signer;
      try { signer = loadReceiptSigner(); } catch { return { ok: false, reason: "no_signing_key" }; }

      // TASK-047. A run that cannot be checked for its canary does not start.
      let canary: string | null = null;
      try { canary = (await ensureCanary(database, ownerId, agentId)).canary; } catch { return { ok: false, reason: "unavailable" }; }
      const runId = randomUUID();

      const rows = ownerRows;
      const timezone = resolveTimezone(rows[0]?.timezone) ?? "UTC";
      // TASK-083. A chat run excludes its current message; a branch uses only messages before its source run.
      // Routines, replays and heal runs are self-contained and never get earlier conversation.
      const conversational = !options?.meta || options.meta.trigger === "chat" || options.meta.trigger === "branch";
      let conversation: Awaited<ReturnType<typeof loadConversation>> = { parts: [], ownerTexts: [] };
      if (conversational) try {
        const before = options?.branch ? (await database.select({ startedAt: runs.startedAt }).from(runs)
          .where(and(eq(runs.ownerId, ownerId), eq(runs.id, options.branch.runId))).limit(1))[0]?.startedAt : undefined;
        conversation = await loadConversation(database, ownerId, agentId, {
          ...(before ? { before } : {}), ...(options?.messageId ? { excludeMessageId: options.messageId } : {}),
        });
      } catch { /* the walk-up is optional; the task remains the owner's latest message */ }

      // No graphical desktop at prepare time: the sandbox starts lazily for shell/files, and a screen action
      // acquires graphics and the managed browser only when the task needs them.
      const lifecycle = createAgentLifecycle(agentId, ownerId, async () => {
        // A lazy start must not revive a paused agent, a stopped crew or a security stop, and it cannot bypass the budget.
        const rows = await database.select({ status: agents.status, attention: agents.attentionReason, crew: owner.crewStoppedAt })
          .from(agents).innerJoin(owner, eq(owner.id, agents.ownerId))
          .where(and(eq(agents.ownerId, ownerId), eq(agents.id, agentId))).limit(1);
        const row = rows[0];
        if (!row || row.status !== "active") throw new DesktopLifecycleError("agent_paused");
        if (row.crew) throw new DesktopLifecycleError("crew_stopped");
        if (row.attention === "security_stop") throw new DesktopLifecycleError("security_stopped");
        const budget = await readBudgetStatus(database, ownerId, agentId, new Date());
        if (budget.state === "paused") throw new DesktopLifecycleError("budget_exhausted");
      });
      const desktop = createLazyDesktopPort(agentId, ownerId, lifecycle);
      const sandboxGeneration = async () => {
        const status = await lifecycle.ensureSandbox();
        if (!status.generation) throw Object.assign(Error("sandbox_start_failed"), { code: "sandbox_start_failed" });
        return status.generation;
      };

      const sam = settings.sam;
      const samProvider = sam?.useMainKey ? provider : sam?.provider;
      // Meta API SAM, or a self-hosted SAM server that speaks the same /v1/responses contract (ADR-010).
      const samLocal = sam?.mode === "local" && samProvider?.kind === "openai-compatible" && Boolean(samProvider.baseUrl);
      const samTransport = (sam?.mode === "meta" && samProvider?.kind === "meta") || samLocal ? proxyTransportFor(samProvider!) : null;
      const samEndpoint = samLocal ? joinProviderUrl(samProvider!.baseUrl!, "responses") : undefined;
      const providerInfo = { providerId: provider.id, kind: provider.kind, baseUrl: provider.baseUrl };
      const samProviderInfo = samProvider ? { providerId: samProvider.id, kind: samProvider.kind, baseUrl: samProvider.baseUrl } : undefined;
      const samConfig = {
        state: (sam?.mode === "meta" || sam?.mode === "local" ? samTransport ? "on" : "unavailable" : "off") as "off" | "on" | "unavailable",
        ...(samTransport ? { transport: samTransport } : {}),
        ...(samEndpoint ? { endpoint: samEndpoint } : {}),
        ...(samProviderInfo ? { provider: samProviderInfo } : {}),
      };
      let approvedSkills: AgentSkill[] = [];
      try { approvedSkills = await listApprovedSkills(database, ownerId, agentId); } catch { approvedSkills = []; }
      // TASK-053. One frozen snapshot per run: a write during this run is visible to the next one, never this one.
      let memory: string | undefined;
      try { memory = (await loadMemorySnapshot(database, ownerId, agentId)).text || undefined; } catch { memory = undefined; }
      let memoryRequests = 0;
      const memoryPort: MemoryPort = {
        propose: async (input) => {
          const result = await proposeMemory(database, {
            ownerId, agentId, runId, queuedThisRun: memoryRequests, scope: input.scope,
            title: input.title, body: input.text, reason: input.reason, op: input.op, quote: input.quote,
          });
          if (result.ok) memoryRequests += 1;
          return result;
        },
      };
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
        setAttention: () => refreshApprovalAttention(database, ownerId, agentId),
        clearAttention: () => refreshApprovalAttention(database, ownerId, agentId),
      });

      // TASK-076. A helper may use only screenless tools the parent already has: document and history reads, and the
      // parent's pinned tool names. The list is code-built; the model cannot widen it.
      const helperTools: string[] = [];
      const actions = agent.actions.map((action) => action.toLowerCase());
      if (actions.includes("read_document")) helperTools.push("read_document");
      if (actions.includes("read_document") || actions.includes("search_document")) helperTools.push("search_document");
      if (actions.includes("search_history") || actions.includes("remember")) helperTools.push("search_history");
      for (const key of agent.tools) helperTools.push(`${key}.*`);
      try {
        for (const account of await listComposioAccounts(database, ownerId, agentId)) {
          if (account.status !== "active") continue;
          for (const tool of account.tools) { helperTools.push(tool.slug); helperTools.push(`composio.${tool.slug}`); }
        }
      } catch { /* no Composio account is simply no extra tool */ }
      const canSpawn = actions.includes("spawn_subagent") && helperTools.length > 0;
      const subagents = canSpawn ? createSubagentManager({
        run: runTask,
        buildChild: async (child) => {
          const childRunId = randomUUID();
          const childCosts = createRunCostSink({
            database, ownerId, agentId, runId: childRunId,
            onWarning: async (card) => { await appendAgentCard(database, ownerId, agentId, { card, sourceTag: "agent", runId: childRunId }); },
          });
          const childProvider = providerInfo ? createCostedConnector(connector, childCosts, providerInfo) : connector;
          const childReceipts = createReceiptRecorder({
            database, ownerId, agentId, agentName: agent.name, task: child.task, signer, runId: childRunId,
            parent: { runId, step: child.parentStep },
            onBegin: async () => { await recordRunMeta(database, { runId: childRunId, ownerId, agentId, trigger: "subagent", parentRunId: runId, label: child.label }); },
          });
          const childApprovals = createApprovalGate({
            database, ownerId,
            postCard: async (card) => { await appendAgentCard(database, ownerId, agentId, { card, sourceTag: "agent", runId: childRunId }); },
            setAttention: () => refreshApprovalAttention(database, ownerId, agentId),
            clearAttention: () => refreshApprovalAttention(database, ownerId, agentId),
          });
          const childActions = [
            "finish", "get_time",
            ...(child.tools.includes("read_document") ? ["read_document"] : []),
            ...(child.tools.includes("search_document") ? ["search_document"] : []),
            ...(child.tools.includes("search_history") ? ["search_history"] : []),
            ...(child.tools.some((tool) => !["read_document", "search_document", "search_history"].includes(tool)) ? ["tool_call"] : []),
          ];
          const childPort: DesktopPort = {
            screenshot: async () => null,
            snapshot: async () => null,
            click: async () => { throw Object.assign(Error("desktop_not_allowed"), { code: "desktop_not_allowed" }); },
            type: async () => { throw Object.assign(Error("desktop_not_allowed"), { code: "desktop_not_allowed" }); },
            key: async () => { throw Object.assign(Error("desktop_not_allowed"), { code: "desktop_not_allowed" }); },
            scroll: async () => { throw Object.assign(Error("desktop_not_allowed"), { code: "desktop_not_allowed" }); },
            available: async () => false,
            ...(desktop.readDocument ? { readDocument: desktop.readDocument.bind(desktop) } : {}),
            ...(desktop.searchDocument ? { searchDocument: desktop.searchDocument.bind(desktop) } : {}),
          };
          const baseTools = createToolPort({ database, ownerId, agentId });
          const childToolPort: ToolPort = {
            prepare: (reference, signal) => baseTools.prepare(reference, signal, { allowedTools: child.tools }),
            ...(baseTools.close ? { close: baseTools.close.bind(baseTools) } : {}),
          };
          return {
            agent: { id: agent.id, name: agent.name, role: agent.role, soulMd: agent.soulMd, instructions: agent.instructions.trim() || defaultInstructions(agent.name, agent.role), actions: childActions, tools: agent.tools, ...(memory ? { memory } : {}) },
            task: child.task, provider: childProvider, model: main.model!,
            claimed: () => undefined,
            ...(main.routing === "auto" && main.hardModel ? { hardModel: main.hardModel } : {}),
            desktop: childPort, receipts: childReceipts, evidence: createEvidenceRecorder({ database, ownerId, runId: childRunId }),
            checkpoints: createCheckpointRecorder({ database, ownerId, runId: childRunId, desktop: childPort }),
            costs: childCosts, approvals: childApprovals, tools: childToolPort,
            history: { search: (query: string) => searchHistory(database, ownerId, agentId, query) },
            canary, allowedHosts: agent.domains, anyPublicWeb: agent.anyPublicWeb, astra: agent.astraMode,
            signal: child.signal,
            maxSteps: child.limits.maxSteps, maxTokens: child.limits.maxTokens, maxWallClockMs: child.limits.maxWallClockMs,
            timezone, silent: true, offeredActions: childActions, allowedTools: child.tools, helperLabel: child.label,
            scopeTask: options?.taskText ?? "", helperTools: [],
            postCard: async () => undefined,
            onSecurityStop: (event) => onSecurityStop({ ...event, runId: childRunId }),
          };
        },
      }) : undefined;

      // TASK-085. A teammate list is shown only to an agent that may hand off. Nothing else is copied.
      // ADR-036. Only crewmates are loaded; a standard agent (no crew) has none, so handoff is never offered to it.
      const crewTeammates = agent.actions.some((action) => action.toLowerCase() === "handoff")
        ? (await loadTeammates(database, ownerId, agentId).catch(() => []))
          .map((mate) => ({ ...mate, status: mate.status === "active" ? "active" as const : "paused" as const }))
        : [];
      const canHandoff = crewTeammates.length > 0;
      const teammates = canHandoff ? crewTeammates : undefined;
      const handoff = canHandoff ? async (input: { agent: string; note: string }) => {
        const result = await performHandoff({
          database, ownerId, senderAgentId: agentId, senderAgentName: agent.name, senderRunId: runId,
          task: options?.taskText ?? "", sourceMessageId: options?.messageId ?? null,
          agent: input.agent, note: input.note,
        }, (receiverAgentId, ownerText, ownerMessageId) => {
          startChatRun(database, ownerId, receiverAgentId, ownerText, { trigger: "handoff", handoffOf: runId }, ownerMessageId,
            { handoffNote: { sender: agent.name, text: input.note }, handoffOf: runId });
        });
        return result.ok ? { ok: true as const, receiverName: result.receiverName } : { ok: false as const, code: result.code };
      } : undefined;
      return {
        samConfig, providerInfo, ...(samProviderInfo ? { samProvider: samProviderInfo } : {}),
        ok: true, provider: connector, model: main.model, hardModel: main.routing === "auto" ? main.hardModel : null, timezone, skills: approvedSkills,
        ...(handoff ? { handoff } : {}), ...(teammates ? { teammates } : {}), ...(options?.handoffNote ? { handoffNote: options.handoffNote } : {}),
        ...(options?.messageId ? { sourceMessageId: options.messageId } : {}),
        ...(helperTools.length ? { helperTools } : {}), ...(subagents ? { subagents } : {}),
        persona: { id: agent.id, name: agent.name, role: agent.role, soulMd: agent.soulMd, instructions: agent.instructions.trim() || defaultInstructions(agent.name, agent.role), actions: agent.actions, tools: agent.tools, ...(memory ? { memory } : {}) },
        tools: createToolPort({ database, ownerId, agentId }),
        shell: createShellPort({ agentId, ownerId, ensure: sandboxGeneration }),
        audio: (costs) => createAudioPort({ database, ownerId, agentId, desktop, ...(costs ? { costs } : {}) }),
        conversation: conversation.parts, scopeTexts: conversation.ownerTexts,
        ...(visibleCatalog.length ? { toolCatalog: visibleCatalog } : {}),
        desktop, canary, onSecurityStop, approvals, allowedHosts: agent.domains, anyPublicWeb: agent.anyPublicWeb, astra: agent.astraMode, memory: memoryPort,
        history: { search: (query: string) => searchHistory(database, ownerId, agentId, query) },
        onScopeBlocked: (rule, blockedRunId) => recordScopeBlocked(database, ownerId, agentId, blockedRunId ?? runId, rule),
        receipts: (task) => createReceiptRecorder({ database, ownerId, agentId, agentName: agent.name, task, signer, runId,
          ...(options?.branch ? { branch: options.branch } : {}),
          ...(options?.handoffOf ? { handoffOf: options.handoffOf } : {}),
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
    heartbeat(ownerId, runId, onCancel, onSealed) {
      return startHeartbeat(database, ownerId, runId, { onCancel, onSealed });
    },
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
): Promise<{ ok: false; reason: "no_model" | "unavailable" | "no_signing_key" | "crew_stopped" } | ({ ok: true } & PreparedChatRun)> {
  const start = await ports.prepare(ownerId, agentId, { ...options, taskText: text });
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
  ownerId: string, agentId: string, text: string, ports: ChatRunPorts, meta?: ChatRunMeta, messageId?: string,
  extra?: Omit<ChatRunPrepareOptions, "meta" | "messageId">,
): Promise<"started" | "busy" | "no_model" | "unavailable" | "no_signing_key" | "crew_stopped" | "failed"> {
  const say = async (message: string) => {
    try { await ports.postCard(ownerId, agentId, { type: "message", text: message }); } catch { /* nothing more to report to */ }
  };
  let control: ReturnType<typeof registerRun> | null = null;
  let toolPort: ToolPort | undefined;
  try {
    const options = { ...(meta ? { meta } : {}), ...(messageId ? { messageId } : {}), ...extra };
    const prepared = await prepareChatRun(ports, ownerId, agentId, text, Object.keys(options).length ? options : undefined);
    if (!prepared.ok) { await say(CHAT_RUN_TEXT[prepared.reason]); return prepared.reason; }
    const { start, receipts, costs, provider, samConfig } = prepared;
    toolPort = start.tools;
    if (receipts?.runId) control = registerRun(receipts.runId, ownerId, agentId);
    const stopHeartbeat = receipts?.runId && ports.heartbeat
      ? ports.heartbeat(ownerId, receipts.runId, () => control?.cancel(), () => control?.cancel()) : undefined;
    let result;
    try {
      result = await ports.run({
      receipts, costs, evidence: start.evidence?.(), checkpoints: start.checkpoints?.(),
      agent: start.persona, task: text, provider, model: start.model, hardModel: start.hardModel, samConfig, desktop: start.desktop,
      skills: start.skills, timezone: start.timezone, ...(control ? { signal: control.signal } : {}),
      canary: start.canary, approvals: start.approvals, allowedHosts: start.allowedHosts, anyPublicWeb: start.anyPublicWeb, onScopeBlocked: start.onScopeBlocked, ...(start.tools ? { tools: start.tools } : {}), ...(start.shell ? { shell: start.shell } : {}),
      ...(start.audio && costs ? { audio: start.audio(costs) } : {}),
      ...(start.conversation?.length ? { conversation: start.conversation } : {}),
      ...(start.scopeTexts?.length ? { scopeTexts: start.scopeTexts } : {}),
      ...(start.toolCatalog?.length ? { toolCatalog: start.toolCatalog } : {}),
      astra: start.astra, memory: start.memory,
      ...(start.handoff ? { handoff: start.handoff } : {}), ...(start.teammates ? { teammates: start.teammates } : {}),
      ...(start.handoffNote ? { handoffNote: start.handoffNote } : {}), ...(start.sourceMessageId ? { sourceMessageId: start.sourceMessageId } : {}),
      ...(start.helperTools ? { helperTools: start.helperTools } : {}), ...(start.subagents ? { subagents: start.subagents } : {}),
      onSecurityStop: start.onSecurityStop
        ? (event) => start.onSecurityStop!({ ...event, runId: receipts?.runId })
        : undefined,
      postCard: (card) => ports.postCard(ownerId, agentId, card, receipts?.runId),
      onFileDelivered: ports.fileDelivered ? (file) => ports.fileDelivered!(ownerId, agentId, file, receipts?.runId) : undefined,
      });
    } finally { stopHeartbeat?.(); }
    if (result.outcome === "busy") { await say(CHAT_RUN_TEXT.busy); return "busy"; }
    // TASK-086. One background review per agent, 120 s after chat activity. Best effort: a queue outage never fails a run.
    void enqueueMemoryReview(ownerId, agentId, receipts?.runId).catch(() => undefined);
    return "started";
  } catch {
    await say(CHAT_RUN_TEXT.unavailable);
    return "failed";
  } finally {
    control?.done();
    await toolPort?.close?.().catch?.(() => undefined);
  }
}

// Fire-and-forget entry for the messages route. The POST has already stored the message and returns without waiting.
export function startChatRun(database: Database, ownerId: string, agentId: string, text: string, meta?: ChatRunMeta, messageId?: string,
  extra?: Omit<ChatRunPrepareOptions, "meta" | "messageId">): void {
  void runChatMessage(ownerId, agentId, text, createChatRunPorts(database), meta, messageId, extra).catch(() => undefined);
}
