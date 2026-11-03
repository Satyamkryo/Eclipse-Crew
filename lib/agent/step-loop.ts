import "server-only";
import type { ProviderConnector, ProviderContent, ProviderUsage } from "../providers/types";
import { getTime } from "../time/clock";
import { buildRequest, summarizeIntent, timeSummary, type AgentPersona, type AgentSkill, type DocumentSearch, type HistorySearch, type ReadDocument, type StepSummary, type ToolResultContext, MAX_DOCUMENT_WINDOWS, MAX_SEARCHES } from "./context";
import type { DeliveredFile, DesktopPort, ListedFile, PageSnapshot, Screenshot } from "./desktop-port";
import { executeIntent, validPoint, type Grounder } from "./executor";
import { createPageGrounder, suggestNames } from "./grounding";
import { notAllowedText } from "../agents/actions";
import { containsCanary } from "../security/canary";
import { DESKTOP_ACTIONS, FILE_ACTIONS, parseNextStep, resolvePlaceholders, type Intent } from "./intent";
import { labelFor, pickRoute, type RouteKind } from "./routing";
import { checkTyped, deriveScope, hostFromUrl, type ScopeRule } from "./scope";
import { classifyAction, type ActionClass, type RiskClass } from "./risk";
import type { ApprovalGate } from "../approvals/types";
import { classifyToolCall } from "../tools/risk";
import { splitToolReference, type ToolPort } from "../tools/port";
import { checkShellExpect, formatShellResult, type PushPending, type ShellPort } from "./shell-port";
import type { AudioPort } from "./audio-port";
import { subagentLimits } from "./subagents";

import { confidenceGate } from "./confidence-gate";
import { createVisualVerifier } from "./visual-verifier";
import { createSamVerifier } from "./sam";
import type { ProviderTransport } from "../providers/types";
import { addUsage, checkCancelled, verifyStep, type Evidence, type Verification, type VerificationServices, type SamState } from "./verification";
import { cleanText } from "../receipts/chain.mjs";
import { actionFor, confidenceFor, methodsFor, screenshotHash, type ReceiptResult, type ReceiptSink, type ReceiptUsage } from "../receipts/fields";
import type { EvidenceSink } from "../receipts/evidence";
import type { CheckpointSink } from "../checkpoints/store";
import type { BudgetCard, RunCostSink } from "../costs/types";

// TASK-072. Tool arguments are checked as data: every string leaf is collected for the scope and canary checks.
function argumentText(value: unknown): string {
  const parts: string[] = [];
  const visit = (node: unknown, depth: number) => {
    if (depth > 8 || parts.length > 512) return;
    if (typeof node === "string") parts.push(node.slice(0, 2000));
    else if (Array.isArray(node)) node.forEach((item) => visit(item, depth + 1));
    else if (node && typeof node === "object") Object.values(node as Record<string, unknown>).forEach((item) => visit(item, depth + 1));
  };
  visit(value, 0);
  return parts.join("\n").slice(0, 12_000);
}

// TASK-087. A dev-agent fix needs more turns than a browser task: clone, install, test, edit, retest, commit, push.
// Only agents whose Actions include `shell` get the larger ceiling; every other agent keeps the base limits.
// TASK-083. Base limits are 60 steps, a 30-minute wall clock and 400,000 weighted tokens for every agent.
export const MAX_STEPS = 60;
export const MAX_REPEATS = 3;
export const MAX_TOKENS = 400_000;
export const MAX_WALL_CLOCK_MS = 30 * 60_000;
export const SHELL_MAX_STEPS = 60;
export const SHELL_MAX_TOKENS = 1_500_000;
export const SHELL_MAX_WALL_CLOCK_MS = 60 * 60_000;
// Cached input costs a tenth of fresh input, so a long cached run is not stopped early.
export function weightedTokens(usage: Pick<ProviderUsage, "inputTokens" | "outputTokens" | "cachedInputTokens">): number {
  const cached = Math.max(0, usage.cachedInputTokens);
  return Math.max(0, usage.inputTokens - cached) + usage.outputTokens + Math.ceil(cached / 10);
}
const MAX_INVALID_IN_A_ROW = 2;
// A click whose target is not found gets one more turn with the visible names; the next miss hands off.
const MAX_MISSES_IN_A_ROW = 2;

export type RunOutcome =
  | "finished" | "asked_owner" | "needs_owner" | "paused_by_owner" | "invalid_output"
  | "step_limit" | "token_limit" | "time_limit" | "repeat_limit" | "budget_paused" | "price_required" | "cost_error"
  | "provider_error" | "desktop_error" | "aborted" | "busy" | "receipt_error" | "security_stop" | "scope_blocked"
  | "handed_off";

export type RunCard =
  | { type: "message"; text: string }
  | { type: "clarification"; question: string; missingParameters: string[] }
  | { type: "approval"; approvalId: string; actionClass: ActionClass; site: string; controlName: string }
  | BudgetCard;

// TASK-043. A branch continues from a checkpoint without replaying earlier steps. Step numbers continue from `turn`.
export interface RunResume {
  history: readonly StepSummary[];
  documents: readonly { name: string; offset: number }[];
  delivered: readonly string[];
  // TASK-084. A branch keeps value names only, never values; the agent extracts again when it needs one.
  valueNames?: readonly string[];
  turn: number;
}

export type SecurityStopSignal = { step: number; cause: "typed_text" | "cancelled" };
export type SecurityStopResult = "posted" | "duplicate" | "failed";

// TASK-054. The agent may only ask; the owner decision writes memory later.
export interface MemoryPort {
  propose(input: {
    scope: "global" | "agent" | "private"; title: string; text: string; reason: string;
    op?: "add" | "replace" | "forget"; quote?: string | null;
  }): Promise<{ ok: true; changeId: string; flags: string[]; applied?: boolean; versionId?: string } | { ok: false; code: string; codes?: string[] }>;
}

export interface RunDeps {
  agent: AgentPersona & { id: string };
  task: string;
  provider: ProviderConnector;
  model: string;
  // Set only when the owner saved Auto routing (TASK-027). Same provider and key as `model`.
  hardModel?: string | null;
  skills?: AgentSkill[];
  desktop: DesktopPort;
  grounder?: Grounder;
  verification?: VerificationServices;
  samConfig?: { state: SamState; transport?: ProviderTransport; provider?: { providerId: string; kind: "meta" | "openai-compatible"; baseUrl: string | null } };
  costs?: RunCostSink;
  // Proof receipts (TASK-029). When set, every step writes a receipt and the run is sealed at the end. A run that cannot
  // record its proof stops with `receipt_error`. Left out only by tests and callers that do not claim proof.
  receipts?: ReceiptSink;
  // Stored screenshots and the SAM box for the History view (TASK-031). Display data only: a failure here never stops a run.
  evidence?: EvidenceSink;
  // Per-step checkpoints of state and files (TASK-032): idx 0 before the first step, then one per receipt. Needs `receipts`. A failure here never stops a run.
  checkpoints?: CheckpointSink;
  // Code-built data derived from page content (TASK-044 heal labels), sent as a `web`-tagged context part.
  untrustedContext?: string;
  // TASK-047. The agent's bait secret. When set, a `type` containing it never reaches execution.
  canary?: string | null;
  // TASK-049. The owner-configured site allowlist. Task scope also comes from the owner's text and the start page.
  allowedHosts?: readonly string[];
  // TASK-050. Risky actions wait here for the owner. Without it, a risky action fails closed.
  approvals?: ApprovalGate;
  // TASK-051. Astra Mode skips only the approval prompt; scope, allowlists, budgets, tripwire and receipts still apply.
  astra?: boolean;
  // TASK-054 / TASK-086. Memory requests; absent means remember is refused.
  memory?: MemoryPort;
  // TASK-086. Search the agent's own chat history. Absent means search_history is refused.
  history?: { search(query: string): Promise<readonly { date: string; snippet: string }[]> };
  // TASK-072. Pinned remote tool calls; absent means tool_call is refused.
  tools?: ToolPort;
  // TASK-073. Shell commands inside the agent namespace; absent means shell is refused.
  shell?: ShellPort;
  // TASK-079. Bounded hearing through the agent's private speaker; absent means hear_audio is refused.
  audio?: AudioPort;
  // TASK-083. Earlier conversation parts and the owner texts they contain (scope only, never the current task).
  conversation?: ProviderContent[];
  scopeTexts?: readonly string[];
  // TASK-085. Handoff execution and the receiver's note; teammates are offered only with the permission.
  handoff?: (input: { agent: string; note: string }) => Promise<{ ok: true; receiverName: string } | { ok: false; code: string }>;
  handoffNote?: { sender: string; text: string };
  teammates?: { name: string; role: string; status: "active" | "paused"; tools: readonly string[] }[];
  sourceMessageId?: string;
  // TASK-076. A helper run posts no card of its own; its final card is returned to the parent as data.
  silent?: boolean;
  // TASK-076. Only these actions are offered and allowed (a helper's subset). Absent for a normal run.
  offeredActions?: readonly string[];
  // TASK-076. The parent's screenless tool subset, enforced again on every call by the tool port.
  allowedTools?: readonly string[];
  // TASK-076. The screenless tools this run may grant to a helper (empty means spawn is not offered).
  helperTools?: readonly string[];
  // TASK-076. The helper's card label for risky approvals ("Helper 2").
  helperLabel?: string;
  // TASK-076. The owner's original task for scope checks; a helper task never widens the scope.
  scopeTask?: string;
  // TASK-076. The manager that runs this run's helpers; absent means spawn_subagent is refused.
  subagents?: import("./subagents").SubagentManager;
  onScopeBlocked?: (rule: ScopeRule, runId?: string) => void | Promise<void>;
  // Called once when a run stops for security. "posted" or "duplicate" means the tripwire owns the one card;
  // "failed" (or no hook) leaves the loop to post its fixed fallback card.
  onSecurityStop?: (event: SecurityStopSignal) => Promise<SecurityStopResult>;
  // The only way a run talks to the owner. Called once per run (never for `busy`).
  postCard: (card: RunCard) => Promise<void>;
  // Called after deliver_file copied a file to outbox/, so its card appears at once. A failure here is ignored:
  // the normal outbox scan finds the same file.
  onFileDelivered?: (file: DeliveredFile) => Promise<void>;
  timezone: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  maxSteps?: number;
  maxTokens?: number;
  maxWallClockMs?: number;
  resume?: RunResume;
  // The caller already holds this agent's run lock and passes its release function.
  claimed?: () => void;
  // Called once, after the run's receipts have begun (or immediately when the run records no receipts).
  onStarted?: () => void;
}

export interface RunStep {
  index: number;
  intent: Intent;
  executed: boolean;
  groundingMethod: string | null;
  // The control a click was grounded on (page text, untrusted), or null.
  grounded: { role: string; name: string } | null;
  verified: boolean;
  verification?: Verification;
  gate?: Evidence[];
  // Which model made this step (TASK-027). `fallback` means the hard-step model failed and Main answered.
  model: string;
  modelLabel: string;
  route: RouteKind;
}

export interface RunResult {
  outcome: RunOutcome;
  steps: RunStep[];
  usage: ProviderUsage;
  cardPosted: boolean;
  // TASK-076. The model's own answer, when it finished; a helper returns this to its parent.
  summary?: string;
  // The card this run would have posted. A silent run never posts it.
  finalCard?: RunCard | null;
}

// One run per agent at a time (ARCHITECTURE 6.2); different agents run in parallel. Kept on globalThis because chat runs and
// replays start from different route bundles (and different module instances in dev), and they must share one lock.
const LOCK_KEY = Symbol.for("eclipse-crew.active-agents");
const activeAgents: Set<string> = ((globalThis as Record<symbol, unknown>)[LOCK_KEY] ??= new Set<string>()) as Set<string>;

// The same lock serves chat runs and replays (TASK-041): one screen, one run. Returns a release function, or null when busy.
export function claimAgent(agentId: string): (() => void) | null {
  if (activeAgents.has(agentId)) return null;
  activeAgents.add(agentId);
  return () => { activeAgents.delete(agentId); };
}

// TASK-042. Retry asks before it starts anything; the run would otherwise only learn it is busy from runTask's own lock.
export function isAgentBusy(agentId: string): boolean {
  return activeAgents.has(agentId);
}

const sameIntent = (a: Intent, b: Intent) => JSON.stringify(a) === JSON.stringify(b);
// TASK-054. The summary promises a save without a memory request: append the fixed correction, never rewrite the text.
const claimsMemorySave = (summary: string) => /\bi(?:'ll| will) remember\b|\bi(?:'ve| have) (?:saved|noted|remembered)\b|\bsaved (?:that )?to memory\b|\bnoted that\b/i.test(summary);
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const errorCode = (error: unknown) => (error as { code?: unknown } | null)?.code;

// Fixed owner-facing text for desktop lifecycle refusals; no raw exception detail reaches the chat.
const LIFECYCLE_FAILURE_TEXT: Record<string, string> = {
  agent_paused: "This agent is paused. Resume the agent before asking me to use the desktop.",
  security_stopped: "This agent is stopped for security review. Resolve it in the Security Center before starting the desktop.",
  budget_exhausted: "This agent is at its budget limit, so I cannot start the desktop.",
  crew_stopped: "The crew is stopped. Resume the crew in the Security Center before starting the desktop.",
  sandbox_start_failed: "The agent's sandbox could not be started. Check the desktop service and try again.",
  profile_busy_or_unsafe: "The browser profile is still in use, so I did not force it. Close the other browser window and ask me again.",
  display_conflict: "Another display is already using this agent's screen, so I did not remove it.",
  browser_start_failed: "The browser could not be started. Close any other window using its profile and ask me again.",
};
const lifecycleFailure = (code: string) =>
  LIFECYCLE_FAILURE_TEXT[code] ?? "The desktop could not be started. Check the desktop service and try again.";
const HEARING_FAILURE_TEXT: Record<string, string> = {
  audio_provider_unavailable: "I cannot hear because no Meta transcription provider and key are configured.",
  price_required: "I cannot hear because the transcription price is not configured.",
  cost_unavailable: "I cannot hear because this run cannot record its cost.",
  budget_paused: "I cannot hear because this agent's budget is paused.",
  audio_already_attempted: "I already reserved a charge for this listening step, so I did not send the audio again.",
  audio_uncertain: "The transcription was uncertain, so I stopped without retrying the paid request.",
  audio_unavailable: "This agent's speaker or browser is not available.",
  audio_capture_failed: "I could not capture audio from this agent's speaker.",
  capture_cancelled: "Listening was cancelled, so I stopped.",
};
const hearingFailure = (code: string) => HEARING_FAILURE_TEXT[code] ?? "I could not hear the page, so I stopped.";

const FIXED_TEXT: Record<Exclude<RunOutcome, "finished" | "asked_owner" | "busy" | "handed_off">, string> = {
  needs_owner: "I stopped and need you to take this step.",
  paused_by_owner: "I stopped because you took over the desktop.",
  invalid_output: "I stopped because the model did not return a usable step twice in a row.",
  step_limit: "I stopped because this run reached its step limit.",
  token_limit: "I stopped because this run reached its token limit.",
  time_limit: "I stopped because this run reached its time limit.",
  repeat_limit: `I stopped because I repeated the same step ${MAX_REPEATS} times.`,
  budget_paused: "I stopped because this agent reached a budget limit. Raise the budget or wait for the next period.",
  price_required: "I stopped before spending because this hosted model has no price configured. Add its rates in Settings -> Models.",
  cost_error: "I stopped because I could not record or check the cost of my last model call.",
  provider_error: "I stopped because the model provider returned an error.",
  desktop_error: "I stopped because the desktop did not accept a command.",
  aborted: "I stopped because the run was cancelled.",
  receipt_error: "I stopped because I could not record proof of my last step.",
  security_stop: "I stopped because a security check found this agent's canary secret in data it was about to send. The desktop was stopped and the agent is paused. Review what happened, then resume the agent when you are ready.",
  scope_blocked: "I stopped because a step tried to type an address or email that is outside the task you gave me. I did not type it. Name the site or address in a new message if you want me to use it.",
};
const HANDOFF_FAILURE_TEXT: Record<string, string> = {
  teammate_unavailable: "That teammate is not available right now.",
  handoff_to_self: "I cannot hand a request to myself.",
  handoff_cycle: "That request already went to this teammate, so I did not send it again.",
  handoff_limit: "This request already passed through two agents, so I did not hand it on again.",
  no_owner_message: "I can only hand off a request you sent in chat, so I did not send this one.",
  invalid_note: "The handoff note was not valid, so I did not send it.",
  start_failed: "The handoff could not be started, so I did not send it.",
};

export async function runTask(deps: RunDeps): Promise<RunResult> {
  const usage: ProviderUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };
  const steps: RunStep[] = [];
  const releaseAgent = deps.claimed ?? claimAgent(deps.agent.id);
  if (!releaseAgent) return { outcome: "busy", steps, usage, cardPosted: false };

  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const grounder = deps.grounder ?? createPageGrounder();
  const shellAgent = deps.agent.actions.some((action) => action.toLowerCase() === "shell");
  const stepCeiling = shellAgent ? SHELL_MAX_STEPS : MAX_STEPS;
  const tokenCeiling = shellAgent ? SHELL_MAX_TOKENS : MAX_TOKENS;
  const wallClockCeiling = shellAgent ? SHELL_MAX_WALL_CLOCK_MS : MAX_WALL_CLOCK_MS;
  const limit = Math.min(deps.maxSteps ?? stepCeiling, stepCeiling);
  const tokenLimit = Math.min(deps.maxTokens ?? tokenCeiling, tokenCeiling);
  const wallClockLimit = Math.min(deps.maxWallClockMs ?? wallClockCeiling, wallClockCeiling);
  let deadlineAt = now().getTime() + wallClockLimit;
  const runController = new AbortController();
  let deadlineExpired = false;
  let typedTail = "";
  let securityCause: "typed_text" | "cancelled" | null = null;
  const armDeadline = () => {
    deadline = setTimeout(() => {
      deadlineExpired = true;
      runController.abort("deadline");
    }, Math.max(0, deadlineAt - now().getTime()));
    deadline.unref?.();
  };
  let deadline: ReturnType<typeof setTimeout> | undefined;
  armDeadline();
  // TASK-050. Time spent waiting for the owner does not count against the run's guard.
  const pauseDeadline = () => { if (deadline) clearTimeout(deadline); deadline = undefined; };
  const resumeDeadline = (waitedMs: number) => { deadlineAt += Math.max(0, waitedMs); armDeadline(); };
  const onOwnerAbort = () => runController.abort(deps.signal?.reason === "security" ? "security" : "owner");
  // TASK-076. A cancelled parent takes its helpers with it, in process and through their own signals.
  const cancelHelpers = () => deps.subagents?.cancelAll();
  const onDependencyAbort = () => { onOwnerAbort(); cancelHelpers(); };
  if (deps.signal?.aborted) { onOwnerAbort(); cancelHelpers(); }
  else deps.signal?.addEventListener("abort", onDependencyAbort, { once: true });
  const runSignal = runController.signal;
  const limitError = (code: "aborted" | "time_limit" | "security") => Object.assign(new Error(code), { code });
  const deadlineReached = () => deadlineExpired || now().getTime() >= deadlineAt;
  const stopIfStopped = () => {
    if (deps.signal?.aborted) {
      if (deps.signal.reason === "security") { securityCause = "cancelled"; stop("security_stop"); }
      else stop("aborted");
      return true;
    }
    if (deadlineReached()) { stop("time_limit"); return true; }
    return false;
  };
  const withinDeadline = async <T>(work: Promise<T>): Promise<T> => {
    if (runSignal.aborted) throw limitError(deadlineExpired ? "time_limit" : deps.signal?.reason === "security" ? "security" : "aborted");
    let abortWork = () => {};
    const stopped = new Promise<never>((_, reject) => {
      abortWork = () => reject(limitError(deadlineExpired ? "time_limit" : deps.signal?.reason === "security" ? "security" : "aborted"));
      runSignal.addEventListener("abort", abortWork, { once: true });
    });
    try { return await Promise.race([work, stopped]); }
    finally { runSignal.removeEventListener("abort", abortWork); }
  };
  const samState = deps.samConfig?.state === "on" && !deps.samConfig.transport ? "unavailable" : deps.samConfig?.state ?? "off";
  const services = deps.verification ?? {
    samState,
    visual: createVisualVerifier({ provider: deps.provider, model: deps.model, task: deps.task, timezone: deps.timezone, now, usage: (value) => addUsage(usage, value), signal: runSignal }),
    ...(samState === "on" && deps.samConfig?.transport ? {
      sam: createSamVerifier({
        transport: deps.samConfig.transport, timezone: deps.timezone, now,
        usage: (value) => addUsage(usage, value), signal: runSignal,
        ...(deps.costs && deps.samConfig.provider ? { costs: deps.costs, provider: deps.samConfig.provider } : {}),
      }),
    } : {}),
  };
  const allowed = new Set(deps.agent.actions.map((action) => action.toLowerCase()));
  let startHref: string | null = null;
  let scopeRefusals = 0;
  const baseTurn = deps.resume?.turn ?? 0;
  const history: StepSummary[] = deps.resume ? [...deps.resume.history] : [];
  // Document references for checkpoints live separately from the live windows, so checkpoint 0 can record the resumed state
  // before the windows are read again.
  const documentRefs: { name: string; offset: number }[] = deps.resume ? [...deps.resume.documents] : [];
  let outcome: RunOutcome = "step_limit";
  let card: RunCard | null = null;
  let summary: string | undefined;
  let invalid = 0;
  let repeats = 0;
  let misses = 0;
  let missedNames: string[] | undefined;
  let previous: Intent | null = null;
  let hardDisabled = false;
  let hardTurns = 0;
  let memoryQueued = 0;
  let memorySaved = 0;
  const documents: ReadDocument[] = [];
  // TASK-082. Only the newest searches stay in context; passage text never enters receipts, checkpoints or logs.
  const searches: DocumentSearch[] = [];
  // TASK-086. The newest chat-history searches stay in context, each with at most five snippets.
  const historySearches: HistorySearch[] = [];
  // TASK-084. Extracted values live in this run's memory only. A resumed branch starts with names and no values.
  const values = new Map<string, string | null>((deps.resume?.valueNames ?? []).map((name) => [name, null]));
  let typeValueNames: string[] = [];
  const delivered: string[] = deps.resume ? [...deps.resume.delivered] : [];
  // TASK-072. Tool results are loop-local and only the newest three are sent to the model.
  const toolResults: ToolResultContext[] = [];
  let toolRefusals = 0;
  // TASK-073c. One card per pending push in this run, and one cleanup of earlier records before
  // the first shell action. The per-agent run lock makes that cleanup exclusive.
  const handledPushes = new Set<string>();
  let pushApprovalsCleared = false;
  const fileActionsOn = FILE_ACTIONS.some((action) => allowed.has(action)) && typeof deps.desktop.listFiles === "function";
  const stop = (next: RunOutcome, text?: RunCard) => { outcome = next; card = text ?? null; };

  // Receipts: token usage is attributed to the receipt written after it was spent, so receipts add up to the run total.
  const receipts = deps.receipts;
  let receiptIdx = 0;
  let usageMark: ReceiptUsage = { input: 0, output: 0, cached: 0, reasoning: 0 };
  let costMark = 0;
  const stopForCost = (error: unknown) => {
    const code = errorCode(error);
    if (code !== "budget_paused" && code !== "price_required" && code !== "cost_error") return false;
    stop(code, (error as { card?: BudgetCard } | null)?.card);
    return true;
  };
  const usageNow = (): ReceiptUsage => ({ input: usage.inputTokens, output: usage.outputTokens, cached: usage.cachedInputTokens, reasoning: usage.reasoningTokens });
  type ModelInfo = { model: string; modelLabel: string; route: RouteKind };
  // Writes one receipt. Returns false when the proof could not be stored; the caller then stops the run.
  const emit = async (intent: Intent, info: ModelInfo, d: {
    result: ReceiptResult; executed: boolean; code?: string | null; target?: { role: string; name: string } | null;
    groundingMethod?: string | null; gate?: Evidence[]; verification?: Verification; before?: Screenshot | null; after?: Screenshot | null;
    exit?: number | null; timeout?: boolean; hits?: number | null; lifecycle?: { graphics: string; browser: string };
    audio?: { seconds: number; chars: number; durationMs: number; sha256: string; bytes: number; model: string };
  }): Promise<boolean> => {
    if (!receipts) return true;
    const action = actionFor(intent);
    if (action?.kind === "shell") { action.exit = d.exit ?? null; action.timeout = d.timeout === true; }
    if (action?.kind === "search_document" || action?.kind === "search_history") action.hits = d.hits ?? 0;
    if (action?.kind === "hear_audio" && d.audio) {
      action.seconds = d.audio.seconds; action.chars = d.audio.chars; action.duration_ms = d.audio.durationMs;
      action.audio_sha256 = d.audio.sha256; action.audio_bytes = d.audio.bytes; action.transcribe_model = d.audio.model;
    }
    if (action?.kind === "type") action.values = [...typeValueNames];
    if (action?.kind === "start_desktop" || action?.kind === "start_browser") {
      action.graphics = d.lifecycle?.graphics ?? "failed"; action.browser = d.lifecycle?.browser ?? "failed";
    }
    if (!action) return true;
    const methods = methodsFor(d.gate, d.verification);
    const spent = usageNow();
    try {
      await receipts.step({
        idx: receiptIdx + 1, model: cleanText(info.model, 128), model_label: cleanText(info.modelLabel, 128), route: info.route, action,
        target: d.target ? { role: cleanText(d.target.role, 64), name: cleanText(d.target.name, 200) } : null,
        grounding_method: d.groundingMethod ? cleanText(d.groundingMethod, 64) : null, methods,
        sam: d.verification?.sam ?? services.samState, confidence: confidenceFor(action, d.result, methods),
        before_hash: d.before ? screenshotHash(d.before.base64) : null, after_hash: d.after ? screenshotHash(d.after.base64) : null,
        postcondition: "expect" in intent ? cleanText(intent.expect, 300) : "", result: d.result, code: d.code ? cleanText(d.code, 64) : null,
        executed: d.executed,
        usage: { input: spent.input - usageMark.input, output: spent.output - usageMark.output, cached: spent.cached - usageMark.cached, reasoning: spent.reasoning - usageMark.reasoning },
        cost_micro_usd: deps.costs ? deps.costs.totalMicroUsd() - costMark : null,
      });
    } catch { return false; }
    receiptIdx += 1;
    await deps.evidence?.record({ idx: receiptIdx, before: d.before ?? null, after: d.after ?? null, samBox: d.verification?.samBox ?? null }).catch(() => undefined);
    await captureCheckpoint(receiptIdx, { intent, result: d.result, code: d.code });
    usageMark = spent;
    costMark = deps.costs?.totalMicroUsd() ?? costMark;
    return true;
  };

  // Checkpoints (TASK-032). The state is what the loop knows right after receipt `idx`, so the step that was just recorded is part of
  // the history even when the loop has not appended it yet. File problems are the recorder's business (it stores a `partial` row).
  let currentTurn = baseTurn;
  const captureCheckpoint = async (idx: number, step?: { intent: Intent; result: ReceiptResult; code?: string | null }) => {
    if (!deps.checkpoints) return;
    let summaries: StepSummary[] = history;
    if (step && !history.some((item) => item.step === currentTurn && item.action === step.intent.action)) {
      const failed = step.result === "fail" || step.result === "failed" || step.result === "blocked";
      summaries = [...history, summarizeIntent(currentTurn, step.intent, failed ? "failed" : "executed", step.code ?? undefined)];
    }
    await deps.checkpoints.capture(idx, { task: deps.task, turn: currentTurn, receiptIdx: idx, history: [...summaries],
      documents: documentRefs.map(({ name, offset }) => ({ name, window: { kind: "text", offset } })), delivered: [...delivered],
      valueNames: [...values.keys()],
      counters: { invalid, repeats, misses, hardTurns, hardDisabled }, previous, usage: usageNow() }).catch(() => undefined);
  };

  let started = true;
  if (receipts) {
    try { await withinDeadline(receipts.begin()); }
    catch (error) { started = false; stop(errorCode(error) === "time_limit" ? "time_limit" : errorCode(error) === "aborted" ? "aborted" : "receipt_error"); }
  }
  if (started) { try { deps.onStarted?.(); } catch { /* the caller's signal only */ } }

  try {
    // Baseline checkpoint: the state and files before the first step. A branch records the resumed state here, before its
    // document windows are read again.
    if (started && receipts) await captureCheckpoint(0);
    if (started && deps.resume && deps.desktop.readDocument) {
      for (const ref of deps.resume.documents) {
        try { documents.push({ name: ref.name, window: await withinDeadline(deps.desktop.readDocument(ref.name, ref.offset)) }); }
        catch {
          if (stopIfStopped()) break;
          // The document is gone: later checkpoints must not claim the branch still holds it.
          const at = documentRefs.findIndex((item) => item.name === ref.name && item.offset === ref.offset);
          if (at >= 0) documentRefs.splice(at, 1);
        }
      }
    }
    for (let turn = 0; started; turn++) {
      currentTurn = baseTurn + turn + 1;
      if (stopIfStopped()) break;
      if (turn >= limit) { stop("step_limit", { type: "message", text: `I stopped after ${limit} steps without finishing.` }); break; }
      if (weightedTokens(usage) >= tokenLimit) { stop("token_limit"); break; }

      // A stopped graphical desktop is not an error: the turn continues on tools, shell, files and text.
      let visual = true;
      if (deps.desktop.available) {
        try { visual = await withinDeadline(deps.desktop.available()); }
        catch { if (stopIfStopped()) break; visual = false; }
      }
      let shot: Screenshot | null = null;
      if (visual) {
        try { shot = await withinDeadline(deps.desktop.screenshot()); }
        catch (error) {
          if (stopIfStopped()) break;
          if (errorCode(error) === "takeover_active") { stop("paused_by_owner"); break; }
          // The graphics or browser closed mid-run. Continue without a screen; a later screen action reacquires it.
          visual = false;
        }
      }

      // One page read per turn, after the screenshot. A failed read only means no control list this turn.
      let snapshot: PageSnapshot | null = null;
      if (shot) {
        try { snapshot = await withinDeadline(deps.desktop.snapshot()); }
        catch (error) {
          if (stopIfStopped()) break;
          if (errorCode(error) === "takeover_active") { stop("paused_by_owner"); break; }
        }
      }

      // The first readable page is the run's start page and is part of the task scope (a mock vendor on loopback works
      // without the owner typing its address).
      if (startHref === null && snapshot && hostFromUrl(snapshot.href)) startHref = snapshot.href;

      // The file list is refreshed each turn (downloads can appear at any time). A failed listing only means no list.
      let files: ListedFile[] | null = null;
      if (fileActionsOn) { try { files = await withinDeadline(deps.desktop.listFiles!()); } catch { if (stopIfStopped()) break; files = null; } }

      // Fixed routing always picks Main. Auto may pick the hard-step model after a failed or repeated turn.
      // A branch's first new turn starts from Main; the resumed history's last result does not escalate it.
      let route: { model: string; kind: RouteKind } = pickRoute({
        main: deps.model, hard: deps.hardModel, hardDisabled, hardTurns, lastResult: turn > 0 ? history[history.length - 1]?.result : undefined, repeats,
      });
      const ask = (model: string) => deps.provider.generate({
        ...buildRequest({
          model, persona: deps.agent, task: deps.task, conversation: deps.conversation, history, files, documents: documents.slice(-MAX_DOCUMENT_WINDOWS),
          searches: searches.slice(-MAX_SEARCHES),
          historySearches: historySearches.slice(-2),
          savedValues: [...values].map(([name, value]) => ({ name, value })),
          toolResults: toolResults.slice(-3),
          skills: deps.skills, screenshotBase64: shot?.base64, snapshot, missedNames, untrustedContext: deps.untrustedContext,
          ...(deps.handoffNote ? { handoffNote: deps.handoffNote } : {}), ...(deps.teammates ? { teammates: deps.teammates } : {}),
          ...(deps.offeredActions ? { offeredActions: deps.offeredActions } : {}),
          offerHandoff: Boolean(deps.handoff && allowed.has("handoff")),
          offerSpawn: Boolean(deps.subagents && deps.helperTools?.length && allowed.has("spawn_subagent")),
          ...(deps.subagents ? {
            helperStatus: deps.subagents.status(),
            helperResults: deps.subagents.results().slice(-5),
          } : {}),
          now: now(), timezone: deps.timezone,
        }),
        signal: runSignal,
      });
      let result;
      try { result = await withinDeadline(ask(route.model)); }
      catch (error) {
        if (stopForCost(error) || stopIfStopped()) break;
        // The hard-step model (a preview model, or one the key cannot use) failed: Main answers this turn and escalation ends.
        if (route.kind !== "hard") { stop("provider_error"); break; }
        hardDisabled = true;
        route = { model: deps.model, kind: "fallback" };
        try { result = await withinDeadline(ask(route.model)); }
        catch (error) { if (!stopForCost(error) && !stopIfStopped()) stop("provider_error"); break; }
      }
      if (route.kind === "hard") hardTurns += 1;
      const modelInfo = { model: route.model, modelLabel: labelFor(route.model), route: route.kind };
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      usage.cachedInputTokens += result.usage.cachedInputTokens;
      usage.reasoningTokens += result.usage.reasoningTokens;
      if (stopIfStopped()) break;
      if (weightedTokens(usage) >= tokenLimit) { stop("token_limit"); break; }

      const parsed = result.status === "completed" ? parseNextStep(result.outputs) : { ok: false as const };
      if (!parsed.ok) {
        history.push({ step: currentTurn, action: "wait", result: "invalid_output" });
        if (++invalid >= MAX_INVALID_IN_A_ROW) { stop("invalid_output"); break; }
        continue;
      }
      invalid = 0;
      let intent = parsed.intent;
      typeValueNames = [];

      // TASK-084. Fill {{name}} from this run's saved values before the canary, scope and typing checks. A missing
      // name (or a value name carried by a branch without its value) makes the step invalid and it is never executed.
      if (intent.action === "type" && intent.text.includes("{{")) {
        const resolved = resolvePlaceholders(intent.text, values);
        if (!resolved.ok || resolved.text.length > 2000) {
          history.push({ step: currentTurn, action: "type", result: "invalid_output" });
          if (++invalid >= MAX_INVALID_IN_A_ROW) { stop("invalid_output"); break; }
          continue;
        }
        typeValueNames = resolved.used;
        intent = { ...intent, text: resolved.text };
      }

      // TASK-047. The model is the only component that can send text out. Check before policy or any desktop call;
      // the receipt keeps no text for a `type`, and the sanitized intent keeps the canary out of steps and checkpoints.
      if (intent.action === "type" && deps.canary && containsCanary(intent.text, deps.canary, typedTail)) {
        const safeIntent: Intent = { action: "type", text: "", expect: "" };
        steps.push({ index: steps.length + 1, intent: safeIntent, executed: false, groundingMethod: null, grounded: null, verified: false, ...modelInfo });
        if (!(await emit(safeIntent, modelInfo, { result: "blocked", executed: false, code: "canary_blocked", before: shot }))) {
          stop("receipt_error");
          break;
        }
        securityCause = "typed_text";
        stop("security_stop");
        break;
      }

      if (intent.action === "finish") {
        // A final summary is still a model claim; only individual postconditions have evidence.
        summary = intent.summary;
        const sent = delivered.length ? `\n\nFiles sent to you: ${delivered.join(", ")}` : "";
        const memoryNote = memoryQueued > 0
          ? `\n\nWaiting for your approval: ${memoryQueued} memory request${memoryQueued === 1 ? "" : "s"}.`
          : memorySaved === 0 && claimsMemorySave(intent.summary) ? "\n\nNo memory request was made in this run, so nothing was saved." : "";
        // TASK-076. Finish waits up to 60 s for helpers, then cancels them and lists each one's outcome honestly.
        let helperNote = "";
        if (deps.subagents && deps.subagents.count() > 0) {
          await deps.subagents.waitForIdle(60_000);
          deps.subagents.cancelAll();
          const lines = deps.subagents.status().map((helper) =>
            `${helper.label}: ${helper.state === "running" ? "stopped (no result before finish)" : helper.state}`);
          if (lines.length) helperNote = `\n\nHelpers:\n${lines.join("\n")}`;
        }
        stop("finished", { type: "message", text: `${intent.summary}${sent}${memoryNote}${helperNote}\n\n${steps.some((step) => step.verified) ? `${steps.filter((step) => step.verified).length} desktop step postcondition(s) passed verification. This summary is the agent's own report; external side effects are not independently proven.` : "This is the agent's own report. Nothing was verified automatically."}` });
        break;
      }
      if (intent.action === "ask_owner") {
        stop("asked_owner", { type: "clarification", question: intent.question, missingParameters: ["answer"] });
        break;
      }

      // TASK-085. Hand the owner's request to one teammate. The receiver's task is the stored owner message;
      // a refusal is reported to the model and this run keeps going, so it can do the work itself.
      if (intent.action === "handoff") {
        if (!allowed.has("handoff") || !deps.handoff) {
          stop("needs_owner", { type: "message", text: notAllowedText("handoff") });
          break;
        }
        let result;
        try { result = await withinDeadline(deps.handoff({ agent: intent.agent, note: intent.note })); }
        catch {
          if (stopIfStopped()) break;
          history.push(summarizeIntent(currentTurn, intent, "failed", "handoff_failed"));
          if (!(await emit(intent, modelInfo, { result: "failed", executed: false, code: "handoff_failed" }))) { stop("receipt_error"); break; }
          continue;
        }
        if (!result.ok) {
          const code = /^[a-z_]{1,64}$/.test(result.code) ? result.code : "handoff_failed";
          // The fixed note tells the model what to do next without exposing another agent's internals.
          history.push({ ...summarizeIntent(currentTurn, intent, "failed", code), expect: HANDOFF_FAILURE_TEXT[code] });
          if (!(await emit(intent, modelInfo, { result: "blocked", executed: false, code }))) { stop("receipt_error"); break; }
          continue;
        }
        steps.push({ index: steps.length + 1, intent, executed: true, groundingMethod: null, grounded: null, verified: false, ...modelInfo });
        history.push(summarizeIntent(currentTurn, intent));
        if (!(await emit(intent, modelInfo, { result: "executed", executed: true }))) { stop("receipt_error"); break; }
        stop("handed_off", { type: "message", text: `Handed this to ${result.receiverName}.` });
        break;
      }

      // TASK-076. Start one screenless helper. Refusals are fixed codes in history; a helper may never spawn another.
      if (intent.action === "spawn_subagent") {
        const nested = deps.offeredActions !== undefined && !deps.offeredActions.includes("spawn_subagent");
        if (nested || !allowed.has("spawn_subagent") || !deps.subagents) {
          const code = nested ? "nested_spawn" : "not_allowed";
          history.push(summarizeIntent(currentTurn, intent, "failed", code));
          if (!(await emit(intent, modelInfo, { result: "blocked", executed: false, code }))) { stop("receipt_error"); break; }
          continue;
        }
        const limits = subagentLimits({ maxSteps: limit, maxTokens: tokenLimit, maxWallClockMs: wallClockLimit });
        const spawned = deps.subagents.spawn({
          task: intent.task, tools: intent.tools, parentStep: currentTurn, limits,
          parentTools: deps.helperTools ?? [], allowSpawn: true,
        });
        if (!spawned.ok) {
          const code = spawned.code;
          history.push({ ...summarizeIntent(currentTurn, intent, "failed", code), expect: code });
          if (!(await emit(intent, modelInfo, { result: "blocked", executed: false, code }))) { stop("receipt_error"); break; }
          continue;
        }
        steps.push({ index: steps.length + 1, intent, executed: true, groundingMethod: null, grounded: null, verified: false, ...modelInfo });
        history.push({ ...summarizeIntent(currentTurn, intent), helper: spawned.label });
        if (!(await emit(intent, modelInfo, { result: "executed", executed: true }))) { stop("receipt_error"); break; }
        continue;
      }

      repeats = previous && sameIntent(previous, intent) ? repeats + 1 : 1;
      previous = intent;
      if (repeats >= MAX_REPEATS) { stop("repeat_limit"); break; }

      // Answered in code from the injected clock: no desktop call, no allowlist entry, not a run step.
      if (intent.action === "get_time") {
        const answer = getTime(now(), intent.timezone, deps.timezone);
        history.push(timeSummary(currentTurn, answer.ok ? answer.text : "unknown_timezone"));
        continue;
      }

      // The agent may start its own graphics/browser. The controller binds the owner and agent, and the owner's
      // pause, security stop and budget gates still apply, so this can never resume a stopped agent.
      if (intent.action === "start_desktop" || intent.action === "start_browser") {
        if (!allowed.has(intent.action)) {
          stop("needs_owner", { type: "message", text: notAllowedText(intent.action) });
          break;
        }
        const ensure = intent.action === "start_desktop" ? deps.desktop.ensureVisual : deps.desktop.ensureBrowser;
        if (!ensure) {
          history.push(summarizeIntent(currentTurn, intent, "failed", "visual_unavailable"));
          if (!(await emit(intent, modelInfo, { result: "blocked", executed: false, code: "visual_unavailable" }))) { stop("receipt_error"); break; }
          stop("needs_owner", { type: "message", text: "I cannot start the desktop in this run." });
          break;
        }
        let status: Awaited<ReturnType<NonNullable<DesktopPort["ensureVisual"]>>>;
        try { status = await withinDeadline(ensure()); }
        catch (error) {
          if (stopIfStopped()) break;
          const raw = errorCode(error);
          const code = typeof raw === "string" && /^[a-z_]{1,64}$/.test(raw) ? raw : `${intent.action}_failed`;
          steps.push({ index: steps.length + 1, intent, executed: false, groundingMethod: null, grounded: null, verified: false, ...modelInfo });
          history.push(summarizeIntent(currentTurn, intent, "failed", code));
          if (!(await emit(intent, modelInfo, { result: "blocked", executed: false, code }))) { stop("receipt_error"); break; }
          stop("needs_owner", { type: "message", text: lifecycleFailure(code) });
          break;
        }
        steps.push({ index: steps.length + 1, intent, executed: true, groundingMethod: null, grounded: null, verified: false, ...modelInfo });
        history.push({ ...summarizeIntent(currentTurn, intent), state: `${status.graphics}/${status.browser}` });
        if (!(await emit(intent, modelInfo, { result: "executed", executed: true, code: intent.action, lifecycle: status }))) { stop("receipt_error"); break; }
        continue;
      }

      // File actions: default-deny by name like every other action. Search accepts read_document or a narrower
      // search_document grant. They never touch the screen, so a failure is reported to the model with the desktop's
      // fixed code instead of stopping the run.
      if (intent.action === "read_document" || intent.action === "search_document" || intent.action === "deliver_file") {
        const port = deps.desktop;
        const readAllowed = allowed.has("read_document");
        const permitted = intent.action === "read_document" ? readAllowed && Boolean(port.readDocument)
          : intent.action === "search_document" ? (readAllowed || allowed.has("search_document")) && Boolean(port.searchDocument)
          : allowed.has("deliver_file") && Boolean(port.deliverFile);
        if (!permitted) {
          stop("needs_owner", { type: "message", text: notAllowedText(intent.action === "search_document" ? "read_document" : intent.action) });
          break;
        }
        let hits: number | undefined;
        try {
          if (intent.action === "read_document") {
            const offset = intent.offset ?? 0;
            documents.push({ name: intent.name, window: await withinDeadline(port.readDocument!(intent.name, offset)) });
            documentRefs.push({ name: intent.name, offset });
          } else if (intent.action === "search_document") {
            const result = await withinDeadline(port.searchDocument!(intent.name, intent.query));
            searches.push({ name: intent.name, query: intent.query, result });
            if (searches.length > MAX_SEARCHES) searches.splice(0, searches.length - MAX_SEARCHES);
            hits = result.results.length;
          } else {
            const file = await withinDeadline(port.deliverFile!(intent.from, intent.name));
            delivered.push(file.name);
            await deps.onFileDelivered?.(file).catch(() => undefined);
          }
        } catch (error) {
          if (stopIfStopped()) break;
          const code = errorCode(error);
          const safeCode = typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : "tool_failed";
          const summary = summarizeIntent(currentTurn, intent, "failed", safeCode);
          history.push(intent.action === "search_document" ? { ...summary, hits: 0 } : summary);
          if (!(await emit(intent, modelInfo, { result: "failed", executed: false, code: safeCode, hits: intent.action === "search_document" ? 0 : undefined }))) { stop("receipt_error"); break; }
          continue;
        }
        steps.push({ index: steps.length + 1, intent, executed: true, groundingMethod: null, grounded: null, verified: false, ...modelInfo });
        const summary = summarizeIntent(currentTurn, intent);
        history.push(hits === undefined ? summary : { ...summary, hits });
        if (!(await emit(intent, modelInfo, { result: "executed", executed: true, hits }))) { stop("receipt_error"); break; }
        continue;
      }

      // TASK-086. Chat-history search over this agent's own messages. It never touches the screen.
      if (intent.action === "search_history") {
        if ((!allowed.has("search_history") && !allowed.has("remember")) || !deps.history) {
          stop("needs_owner", { type: "message", text: notAllowedText("remember") });
          break;
        }
        let hits;
        try { hits = await withinDeadline(deps.history.search(intent.query)); }
        catch (error) {
          if (stopIfStopped()) break;
          const raw = errorCode(error);
          const code = typeof raw === "string" && /^[a-z_]{1,64}$/.test(raw) ? raw : "history_search_failed";
          history.push({ ...summarizeIntent(currentTurn, intent, "failed", code), hits: 0 });
          if (!(await emit(intent, modelInfo, { result: "failed", executed: false, code, hits: 0 }))) { stop("receipt_error"); break; }
          continue;
        }
        if (!hits.length) {
          history.push({ ...summarizeIntent(currentTurn, intent, "failed", "no_match"), hits: 0 });
          if (!(await emit(intent, modelInfo, { result: "failed", executed: false, code: "no_match", hits: 0 }))) { stop("receipt_error"); break; }
          continue;
        }
        historySearches.push({ query: intent.query, hits });
        if (historySearches.length > 2) historySearches.splice(0, historySearches.length - 2);
        steps.push({ index: steps.length + 1, intent, executed: true, groundingMethod: null, grounded: null, verified: false, ...modelInfo });
        history.push({ ...summarizeIntent(currentTurn, intent), hits: hits.length });
        if (!(await emit(intent, modelInfo, { result: "executed", executed: true, hits: hits.length }))) { stop("receipt_error"); break; }
        continue;
      }

      // TASK-054. A memory request is add-only and never writes memory: it queues one owner review. It never touches
      // the screen, so refusals are reported to the model in history and the run continues.
      if (intent.action === "remember") {
        if (!allowed.has("remember")) {
          stop("needs_owner", { type: "message", text: notAllowedText("remember") });
          break;
        }
        if (!deps.memory) {
          history.push(summarizeIntent(currentTurn, intent, "failed", "memory_unavailable"));
          if (!(await emit(intent, modelInfo, { result: "blocked", executed: false, code: "memory_unavailable" }))) { stop("receipt_error"); break; }
          continue;
        }
        let proposed;
        try {
          proposed = await withinDeadline(deps.memory.propose({
            scope: intent.scope, title: intent.title, text: intent.text ?? "", reason: intent.reason,
            op: intent.op, quote: intent.quote ?? null,
          }));
        }
        catch { proposed = { ok: false as const, code: "memory_unavailable" }; }
        if (!proposed.ok) {
          const code = /^[a-z_]{1,64}$/.test(proposed.code) ? proposed.code : "memory_unavailable";
          history.push(summarizeIntent(currentTurn, intent, "failed", code));
          steps.push({ index: steps.length + 1, intent, executed: false, groundingMethod: null, grounded: null, verified: false, ...modelInfo });
          if (!(await emit(intent, modelInfo, { result: "blocked", executed: false, code }))) { stop("receipt_error"); break; }
          continue;
        }
        const applied = proposed.applied === true;
        if (applied) memorySaved += 1; else memoryQueued += 1;
        steps.push({ index: steps.length + 1, intent, executed: true, groundingMethod: null, grounded: null, verified: false, ...modelInfo });
        history.push(summarizeIntent(currentTurn, intent));
        if (!(await emit(intent, modelInfo, { result: "executed", executed: true, code: applied ? "saved" : "queued" }))) { stop("receipt_error"); break; }
        continue;
      }

      // TASK-072. Remote tool calls: allowlist, server grant, argument scope/canary, code-side risk, then approval and call.
      // Results are untrusted data and never enter a receipt, checkpoint or history summary.
      if (intent.action === "tool_call") {
        if (!allowed.has("tool_call") || !deps.tools) {
          stop("needs_owner", { type: "message", text: notAllowedText("tool_call") });
          break;
        }
        const split = splitToolReference(intent.name);
        const grantedServers = deps.agent.tools ?? [];
        if (!split || !grantedServers.includes(split.serverKey)) {
          steps.push({ index: steps.length + 1, intent, executed: false, groundingMethod: null, grounded: null, verified: false, ...modelInfo });
          history.push(summarizeIntent(currentTurn, intent, "failed", "tool_not_granted"));
          if (!(await emit(intent, modelInfo, { result: "blocked", executed: false, code: "tool_not_granted" }))) { stop("receipt_error"); break; }
          toolRefusals += 1;
          if (toolRefusals >= 2) {
            stop("needs_owner", { type: "message", text: `I am not allowed to use the "${intent.name}" tool. Add the server key to this agent's Tools in its settings, and "tool_call" to its Actions.` });
            break;
          }
          continue;
        }

        let args: Record<string, unknown>;
        try {
          const parsed = JSON.parse(intent.args);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          args = parsed as Record<string, unknown>;
        } catch {
          history.push(summarizeIntent(currentTurn, intent, "failed", "tool_invalid_arguments"));
          if (!(await emit(intent, modelInfo, { result: "blocked", executed: false, code: "tool_invalid_arguments" }))) { stop("receipt_error"); break; }
          continue;
        }
        const text = argumentText(args);
        const scope = deriveScope({ task: deps.scopeTask ?? deps.task, allowedHosts: deps.allowedHosts, startHref, extraOwnerTexts: deps.scopeTexts });
        const verdict = checkTyped(text, scope, null);
        if (!verdict.ok) {
          const code = verdict.rule === "recipient" ? "out_of_scope_recipient" : "out_of_scope_host";
          steps.push({ index: steps.length + 1, intent, executed: false, groundingMethod: null, grounded: null, verified: false, ...modelInfo });
          history.push(summarizeIntent(currentTurn, intent, "failed", "out_of_scope"));
          if (!(await emit(intent, modelInfo, { result: "blocked", executed: false, code }))) { stop("receipt_error"); break; }
          try { await deps.onScopeBlocked?.(verdict.rule ?? "host", receipts?.runId); } catch { /* the refusal stands */ }
          scopeRefusals += 1;
          if (scopeRefusals >= 2) { stop("scope_blocked"); break; }
          continue;
        }
        if (deps.canary && containsCanary(text, deps.canary)) {
          if (!(await emit(intent, modelInfo, { result: "blocked", executed: false, code: "canary_blocked" }))) { stop("receipt_error"); break; }
          securityCause = "typed_text";
          stop("security_stop");
          break;
        }

        let tool: Awaited<ReturnType<ToolPort["prepare"]>>;
        try { tool = await withinDeadline(deps.tools.prepare(intent.name, runSignal, deps.allowedTools ? { allowedTools: deps.allowedTools } : undefined)); }
        catch (error) {
          if (stopIfStopped()) break;
          const raw = errorCode(error);
          const code = typeof raw === "string" && /^[a-z_]{1,64}$/.test(raw) ? raw : "tool_failed";
          history.push(summarizeIntent(currentTurn, intent, "failed", code));
          if (!(await emit(intent, modelInfo, { result: "blocked", executed: false, code }))) { stop("receipt_error"); break; }
          continue;
        }

        const risky = classifyToolCall(tool.tool, tool.annotations);
        let astraAllowed = false;
        if (risky !== "none") {
          if (!deps.approvals) {
            history.push(summarizeIntent(currentTurn, intent, "failed", "approval_required"));
            if (!(await emit(intent, modelInfo, { result: "blocked", executed: false, code: "approval_required" }))) { stop("receipt_error"); break; }
            stop("needs_owner", { type: "message", text: "I stopped because this tool call needs your approval, and approvals are not available in this run." });
            break;
          }
          pauseDeadline();
          let answer;
          try {
            answer = await deps.approvals.request({
              agentId: deps.agent.id, runId: receipts?.runId ?? null, actionClass: risky,
              site: tool.host, controlName: `${tool.serverKey}.${tool.tool}`.slice(0, 120), signal: runSignal, astra: deps.astra === true, ...(deps.helperLabel ? { helperLabel: deps.helperLabel } : {}),
            });
          } catch {
            resumeDeadline(0);
            if (!stopIfStopped()) stop("needs_owner", { type: "message", text: "I stopped because the approval request could not be completed." });
            break;
          }
          resumeDeadline(answer.waitedMs);
          if (answer.reason === "aborted") { stopIfStopped(); break; }
          if (answer.decision === "deny") {
            const code = answer.reason === "timeout" ? "approval_timeout" : "approval_denied";
            history.push(summarizeIntent(currentTurn, intent, "failed", code));
            if (!(await emit(intent, modelInfo, { result: "blocked", executed: false, code }))) { stop("receipt_error"); break; }
            stop("needs_owner", { type: "message", text: answer.reason === "timeout"
              ? "I stopped because this action was not approved in time."
              : "I stopped because you denied this action." });
            break;
          }
          astraAllowed = answer.reason === "astra";
        }

        try {
          const result = await withinDeadline(tool.invoke(args, runSignal));
          toolResults.push({ name: intent.name, is_error: result.isError, text: result.text });
          if (toolResults.length > 3) toolResults.splice(0, toolResults.length - 3);
          steps.push({ index: steps.length + 1, intent, executed: true, groundingMethod: null, grounded: null, verified: false, ...modelInfo });
          history.push(summarizeIntent(currentTurn, intent));
          const code = result.isError ? "tool_error" : astraAllowed ? "astra_allowed" : null;
          if (!(await emit(intent, modelInfo, { result: "executed", executed: true, code }))) { stop("receipt_error"); break; }
        } catch (error) {
          if (stopIfStopped()) break;
          const raw = errorCode(error);
          const code = typeof raw === "string" && /^[a-z_]{1,64}$/.test(raw) ? raw : "tool_failed";
          if (code === "canary_blocked") {
            if (!(await emit(intent, modelInfo, { result: "blocked", executed: false, code }))) { stop("receipt_error"); break; }
            securityCause = "typed_text";
            stop("security_stop");
            break;
          }
          history.push(summarizeIntent(currentTurn, intent, "failed", code));
          if (!(await emit(intent, modelInfo, { result: "failed", executed: false, code }))) { stop("receipt_error"); break; }
        }
        continue;
      }

      // TASK-073. Shell commands run as the agent inside its private namespace. The command is canary-scanned and never
      // stored in a receipt or checkpoint; output is untrusted and only reaches the model.
      if (intent.action === "shell") {
        if (!allowed.has("shell") || !deps.shell) {
          stop("needs_owner", { type: "message", text: notAllowedText("shell") });
          break;
        }
        if (deps.canary && containsCanary(intent.command, deps.canary)) {
          if (!(await emit(intent, modelInfo, { result: "blocked", executed: false, code: "canary_blocked" }))) { stop("receipt_error"); break; }
          securityCause = "typed_text";
          stop("security_stop");
          break;
        }
        // TASK-073c. A crashed or cancelled earlier run may have left pending records or grants.
        // Clear them once before this run's first shell action; the per-agent lock is already held.
        if (!pushApprovalsCleared) {
          pushApprovalsCleared = true;
          if (typeof deps.shell.clearApprovals === "function") {
            try { await withinDeadline(deps.shell.clearApprovals()); }
            catch {
              if (stopIfStopped()) break;
              stop("needs_owner", { type: "message", text: "I stopped because I could not clear earlier push approvals." });
              break;
            }
          }
        }
        let shellResult;
        try {
          shellResult = await withinDeadline(deps.shell.run({
            command: intent.command,
            ...(intent.cwd ? { cwd: intent.cwd } : {}),
            ...(intent.timeout ? { timeout: intent.timeout } : {}),
          }, runSignal));
        } catch (error) {
          if (stopIfStopped()) break;
          const raw = errorCode(error);
          const code = typeof raw === "string" && /^[a-z_]{1,64}$/.test(raw) ? raw : "shell_failed";
          history.push(summarizeIntent(currentTurn, intent, "failed", code));
          if (!(await emit(intent, modelInfo, { result: "failed", executed: false, code }))) { stop("receipt_error"); break; }
          continue;
        }
        // TASK-073c. The gateway records a blocked protected ref as pending. Poll after every
        // shell step; a polling failure stops the run rather than guessing.
        let pendingPushes: PushPending[] = [];
        if (typeof deps.shell.pending === "function") {
          try { pendingPushes = await withinDeadline(deps.shell.pending()); }
          catch {
            if (stopIfStopped()) break;
            stop("needs_owner", { type: "message", text: "I stopped because I could not check whether the push needs your approval." });
            break;
          }
        }
        const freshPushes = pendingPushes.filter((item) => !handledPushes.has(item.id));
        const expectation = checkShellExpect(intent.expect, shellResult);
        const code = freshPushes.length > 0 ? "push_blocked"
          : shellResult.timedOut ? "timeout" : shellResult.exit !== 0 ? "exit_nonzero" : expectation === "fail" ? "expect_failed" : null;
        toolResults.push({ name: `shell:${intent.command.trim().split(/[ \t]+/)[0] ?? ""}`.slice(0, 200), is_error: shellResult.exit !== 0, text: formatShellResult(shellResult) });
        if (toolResults.length > 3) toolResults.splice(0, toolResults.length - 3);
        steps.push({ index: steps.length + 1, intent, executed: true, groundingMethod: null, grounded: null, verified: false, ...modelInfo });
        history.push(summarizeIntent(currentTurn, intent, "executed", code ?? undefined));
        if (!(await emit(intent, modelInfo, { result: "executed", executed: true, code, exit: shellResult.exit, timeout: shellResult.timedOut }))) { stop("receipt_error"); break; }
        if (freshPushes.length === 0) continue;

        // One card per pending ref, deduplicated by its proxy id. Denying any ref clears the whole
        // request group; granting one ref never authorizes another.
        if (!deps.approvals) {
          stop("needs_owner", { type: "message", text: "I stopped because this push needs your approval, and approvals are not available in this run." });
          break;
        }
        const approved: { item: PushPending; reason: string }[] = [];
        let denied: { item: PushPending; reason: string } | null = null;
        let approvalFailed = false;
        for (const item of freshPushes) {
          handledPushes.add(item.id);
          pauseDeadline();
          let answer;
          try {
            answer = await deps.approvals.request({
              agentId: deps.agent.id, runId: receipts?.runId ?? null, actionClass: item.actionClass,
              site: item.site, controlName: item.controlName, signal: runSignal, astra: deps.astra === true, ...(deps.helperLabel ? { helperLabel: deps.helperLabel } : {}),
            });
          } catch {
            resumeDeadline(0);
            stop("needs_owner", { type: "message", text: "I stopped because the push approval request could not be completed." });
            approvalFailed = true;
            break;
          }
          resumeDeadline(answer.waitedMs);
          if (answer.decision === "deny") { denied = { item, reason: answer.reason }; break; }
          // Record the decision before any grant exists. A failed receipt issues nothing.
          const decisionCode = answer.reason === "astra" ? "astra_allowed" : "push_approved";
          if (!(await emit(intent, modelInfo, { result: "blocked", executed: false, code: decisionCode }))) {
            stop("receipt_error");
            approvalFailed = true;
            break;
          }
          approved.push({ item, reason: answer.reason });
        }
        if (approvalFailed) break;
        if (denied) {
          try { if (typeof deps.shell.deny === "function") await withinDeadline(deps.shell.deny(denied.item.id)); } catch { /* expiry is the fallback */ }
          const decisionCode = denied.reason === "timeout" ? "approval_timeout"
            : denied.reason === "aborted" ? "approval_aborted" : "approval_denied";
          if (!(await emit(intent, modelInfo, { result: "blocked", executed: false, code: decisionCode }))) { stop("receipt_error"); break; }
          if (!stopIfStopped()) {
            stop("needs_owner", { type: "message", text: denied.reason === "timeout"
              ? "I stopped because the push was not approved in time."
              : denied.reason === "aborted" ? "I stopped because the run ended before the push was approved."
                : "I stopped because you denied this push." });
          }
          break;
        }
        if (approved.length !== freshPushes.length) break;
        let grantFailed = false;
        for (const decision of approved) {
          try {
            if (typeof deps.shell.grant !== "function") throw Object.assign(Error("approval_unavailable"), { code: "approval_unavailable" });
            await withinDeadline(deps.shell.grant(decision.item.id));
          } catch {
            try { if (typeof deps.shell.deny === "function") await deps.shell.deny(decision.item.id); } catch { /* expiry is the fallback */ }
            stop("needs_owner", { type: "message", text: "I stopped because the push approval could not be saved." });
            grantFailed = true;
            break;
          }
        }
        if (grantFailed) break;
        // Never rerun the blocked command: earlier commands in it may have already acted. The
        // model gets a fresh-step hint and must issue a new shell step containing only the push.
        toolResults.push({ name: "git:approval", is_error: false, text: "Push approved by the owner. Start a new shell step that runs only the approved push; earlier commands in the blocked step are not repeated." });
        if (toolResults.length > 3) toolResults.splice(0, toolResults.length - 3);
        continue;
      }

      // TASK-079. Hearing is a read-only capture of this agent's own speaker. It never touches screen input and
      // its transcript enters the next request only as a bounded `tool` result.
      if (intent.action === "hear_audio") {
        if (!allowed.has("hear_audio") || !deps.audio) {
          stop("needs_owner", { type: "message", text: notAllowedText("hear_audio") });
          break;
        }
        const seconds = intent.seconds ?? 10;
        let heard;
        try { heard = await withinDeadline(deps.audio.hear(seconds, `audio:${steps.length + 1}`)); }
        catch (error) {
          if (stopIfStopped()) break;
          const raw = errorCode(error);
          const code = typeof raw === "string" && /^[a-z_]{1,64}$/.test(raw) ? raw : "audio_failed";
          history.push(summarizeIntent(currentTurn, intent, "failed", code));
          if (!(await emit(intent, modelInfo, { result: "blocked", executed: false, code }))) { stop("receipt_error"); break; }
          stop("needs_owner", { type: "message", text: hearingFailure(code) });
          break;
        }
        toolResults.push({ name: "hear_audio", is_error: false,
          text: (heard.text ? `Hearing result (untrusted): ${heard.text}` : "Hearing result: no speech was detected.").slice(0, 4000) });
        if (toolResults.length > 3) toolResults.splice(0, toolResults.length - 3);
        steps.push({ index: steps.length + 1, intent, executed: true, groundingMethod: null, grounded: null, verified: false, ...modelInfo });
        history.push(summarizeIntent(currentTurn, intent));
        if (!(await emit(intent, modelInfo, { result: "executed", executed: true,
          audio: { seconds, chars: [...heard.text].length, durationMs: heard.durationMs, sha256: heard.sha256, bytes: heard.bytes, model: heard.model } }))) {
          stop("receipt_error"); break;
        }
        continue;
      }

      // Policy: default-deny on the agent's action allowlist. TASK-084 adds no new permission names: navigate needs
      // `type` (it is the same as typing an address), select needs `click`, and extract needs either because it only reads.
      const permission = intent.action === "navigate" ? "type" : intent.action === "select" ? "click" : intent.action;
      const permitted = intent.action === "extract"
        ? allowed.has("click") || allowed.has("type")
        : (DESKTOP_ACTIONS as readonly string[]).includes(permission) && allowed.has(permission);
      if (!permitted) {
        stop("needs_owner", { type: "message", text: notAllowedText(intent.action === "extract" ? (allowed.has("click") ? "type" : "click") : permission) });
        break;
      }

      // A screen action on a stopped desktop acquires it through the bounded lifecycle, then re-grounds on fresh state.
      // The generation is re-read by the port, so an old screenshot or context is never reused.
      if (!shot) {
        try {
          if (!deps.desktop.ensureVisual) throw Object.assign(Error("visual_unavailable"), { code: "visual_unavailable" });
          await withinDeadline(deps.desktop.ensureVisual());
          shot = await withinDeadline(deps.desktop.screenshot());
          if (!shot) throw Object.assign(Error("visual_unavailable"), { code: "visual_unavailable" });
          snapshot = await withinDeadline(deps.desktop.snapshot()).catch(() => null);
          if (startHref === null && snapshot && hostFromUrl(snapshot.href)) startHref = snapshot.href;
        } catch (error) {
          if (stopIfStopped()) break;
          const raw = errorCode(error);
          const code = typeof raw === "string" && /^[a-z_]{1,64}$/.test(raw) ? raw : "desktop_start_failed";
          history.push(summarizeIntent(currentTurn, intent, "failed", code));
          if (!(await emit(intent, modelInfo, { result: "blocked", executed: false, code }))) { stop("receipt_error"); break; }
          stop("needs_owner", { type: "message", text: lifecycleFailure(code) });
          break;
        }
      }
      if (!shot) { stop("desktop_error"); break; }

      // TASK-084. Extract saves the exact page text under a name, so one type step can reuse it with {{name}}. The
      // value is checked against the canary and the task's hosts first; it only enters run memory when the page shows it.
      if (intent.action === "extract") {
        if (!deps.desktop.findText) {
          stop("needs_owner", { type: "message", text: "I cannot read page text in this run." });
          break;
        }
        if (deps.canary && containsCanary(intent.value, deps.canary)) {
          const safeIntent: Intent = { action: "extract", name: intent.name, value: "", expect: "" };
          steps.push({ index: steps.length + 1, intent: safeIntent, executed: false, groundingMethod: null, grounded: null, verified: false, ...modelInfo });
          if (!(await emit(safeIntent, modelInfo, { result: "blocked", executed: false, code: "canary_blocked", before: shot }))) { stop("receipt_error"); break; }
          securityCause = "typed_text";
          stop("security_stop");
          break;
        }
        const scope = deriveScope({ task: deps.scopeTask ?? deps.task, allowedHosts: deps.allowedHosts, startHref, extraOwnerTexts: deps.scopeTexts });
        const verdict = checkTyped(intent.value, scope, null);
        if (!verdict.ok) {
          const rule = verdict.rule ?? "host";
          const code = rule === "host" ? "out_of_scope_host" : rule === "recipient" ? "out_of_scope_recipient" : "page_out_of_scope";
          steps.push({ index: steps.length + 1, intent, executed: false, groundingMethod: null, grounded: null, verified: false, ...modelInfo });
          history.push(summarizeIntent(currentTurn, intent, "failed", "out_of_scope"));
          if (!(await emit(intent, modelInfo, { result: "blocked", executed: false, code, before: shot }))) { stop("receipt_error"); break; }
          try { await deps.onScopeBlocked?.(rule, receipts?.runId); } catch { /* the refusal stands */ }
          scopeRefusals += 1;
          if (scopeRefusals >= 2) { stop("scope_blocked"); break; }
          continue;
        }
        if (!values.has(intent.name) && values.size >= 10) {
          history.push(summarizeIntent(currentTurn, intent, "failed", "value_limit"));
          if (!(await emit(intent, modelInfo, { result: "blocked", executed: false, code: "value_limit" }))) { stop("receipt_error"); break; }
          continue;
        }
        let found;
        try { found = await withinDeadline(deps.desktop.findText(intent.value)); }
        catch (error) {
          if (stopIfStopped()) break;
          const raw = errorCode(error);
          const code = typeof raw === "string" && /^[a-z_]{1,64}$/.test(raw) ? raw : "text_check_failed";
          history.push(summarizeIntent(currentTurn, intent, "failed", code));
          if (!(await emit(intent, modelInfo, { result: "failed", executed: false, code }))) { stop("receipt_error"); break; }
          continue;
        }
        if (!found.found) {
          history.push(summarizeIntent(currentTurn, intent, "failed", "text_not_found"));
          if (!(await emit(intent, modelInfo, { result: "failed", executed: false, code: "text_not_found" }))) { stop("receipt_error"); break; }
          continue;
        }
        values.set(intent.name, intent.value);
        steps.push({ index: steps.length + 1, intent, executed: true, groundingMethod: null, grounded: null, verified: false, ...modelInfo });
        history.push(summarizeIntent(currentTurn, intent));
        if (!(await emit(intent, modelInfo, { result: "executed", executed: true }))) { stop("receipt_error"); break; }
        continue;
      }

      // TASK-049. A `type` may only send the run to a host the owner named, or to an email the owner named. A navigate
      // names a host too. A refusal writes one blocked receipt and tells the model; the second refusal stops the run.
      if (intent.action === "type" || intent.action === "navigate") {
        const scope = deriveScope({ task: deps.scopeTask ?? deps.task, allowedHosts: deps.allowedHosts, startHref, extraOwnerTexts: deps.scopeTexts });
        const verdict = intent.action === "type" ? checkTyped(intent.text, scope, snapshot?.href ?? null) : checkTyped(intent.url, scope, null);
        if (!verdict.ok) {
          const rule = verdict.rule ?? "host";
          const code = rule === "host" ? "out_of_scope_host" : rule === "recipient" ? "out_of_scope_recipient" : "page_out_of_scope";
          const refused: RunStep = { index: steps.length + 1, intent, executed: false, groundingMethod: null, grounded: null, verified: false, ...modelInfo };
          steps.push(refused);
          history.push(summarizeIntent(currentTurn, intent, "failed", "out_of_scope"));
          if (!(await emit(intent, modelInfo, { result: "blocked", executed: false, code, before: shot }))) { stop("receipt_error"); break; }
          try { await deps.onScopeBlocked?.(rule, receipts?.runId); } catch { /* the refusal stands even when the event cannot be stored */ }
          scopeRefusals += 1;
          if (scopeRefusals >= 2) { stop("scope_blocked"); break; }
          continue;
        }
      }

      missedNames = undefined;
      let point = null;
      if (intent.action === "click" || intent.action === "select") {
        point = await withinDeadline(grounder.ground(intent, shot, snapshot)).catch(() => null);
        if (!validPoint(point, shot)) {
          // First miss on a readable page: show the model the visible names once. Otherwise hand off.
          if (snapshot && ++misses < MAX_MISSES_IN_A_ROW) {
            history.push(summarizeIntent(currentTurn, intent, "target_not_found"));
            missedNames = suggestNames(snapshot, intent.target);
            continue;
          }
          const hidden = snapshot ? " It may be inside a closed shadow root, which I can't reach." : "";
          stop("needs_owner", { type: "message", text: snapshot
            ? `I can't locate that control on the page, so I am handing this back to you.${hidden}`
            : "I can't locate that on the screen yet, so I am handing this back to you." });
          break;
        }
      }
      misses = 0;

      const record: RunStep = { index: steps.length + 1, intent, executed: false, groundingMethod: point?.method ?? null,
        grounded: point?.role !== undefined && point.name !== undefined ? { role: point.role, name: point.name } : null, verified: false, ...modelInfo };

      // TASK-050. A risky click classification is made by code, not by the model. It waits for the owner (or a stored
      // grant), then the page is read again before the gate and execution.
      const risky: RiskClass = classifyAction({
        intentKind: intent.action,
        controlName: record.grounded?.name ?? ("target" in intent ? intent.target : ""),
        expect: "expect" in intent ? intent.expect : "",
      });
      let receiptBase = { target: record.grounded, groundingMethod: record.groundingMethod, before: shot };
      // TASK-051. Set only for a step the approval gate auto-allowed, so its receipt says what ran unattended.
      let astraAllowed = false;
      if (risky !== "none") {
        if (!deps.approvals) {
          steps.push(record);
          history.push(summarizeIntent(currentTurn, intent, "failed", "approval_required"));
          if (!(await emit(intent, modelInfo, { ...receiptBase, result: "blocked", executed: false, code: "approval_required" }))) { stop("receipt_error"); break; }
          stop("needs_owner", { type: "message", text: "I stopped because this action needs your approval, and approvals are not available in this run." });
          break;
        }
        pauseDeadline();
        let answer;
        try {
          answer = await deps.approvals.request({
            agentId: deps.agent.id, runId: receipts?.runId ?? null, actionClass: risky,
            site: hostFromUrl(snapshot?.href), controlName: record.grounded?.name ?? "this action", signal: runSignal,
            astra: deps.astra === true, ...(deps.helperLabel ? { helperLabel: deps.helperLabel } : {}),
          });
        } catch {
          resumeDeadline(0);
          if (!stopIfStopped()) stop("needs_owner", { type: "message", text: "I stopped because the approval request could not be completed." });
          break;
        }
        resumeDeadline(answer.waitedMs);
        if (answer.reason === "aborted") { stopIfStopped(); break; }
        if (answer.decision === "deny") {
          const code = answer.reason === "timeout" ? "approval_timeout" : "approval_denied";
          steps.push(record);
          history.push(summarizeIntent(currentTurn, intent, "failed", code));
          if (!(await emit(intent, modelInfo, { ...receiptBase, result: "blocked", executed: false, code }))) { stop("receipt_error"); break; }
          stop("needs_owner", { type: "message", text: answer.reason === "timeout"
            ? "I stopped because this action was not approved in time."
            : "I stopped because you denied this action." });
          break;
        }
        astraAllowed = answer.reason === "astra";

        // The answer can arrive long after the screenshot the request was based on. Read the page again and re-ground.
        let freshShot: Screenshot | null;
        let freshSnapshot: PageSnapshot | null;
        try {
          freshShot = await withinDeadline(deps.desktop.screenshot());
          freshSnapshot = await withinDeadline(deps.desktop.snapshot());
        } catch (error) {
          if (stopIfStopped()) break;
          stop(errorCode(error) === "takeover_active" ? "paused_by_owner" : "desktop_error");
          break;
        }
        if (!freshShot) { stop("desktop_error"); break; }
        let freshPoint = point;
        if (intent.action === "click") {
          freshPoint = await withinDeadline(grounder.ground(intent, freshShot, freshSnapshot)).catch(() => null);
        }
        const moved = intent.action === "click"
          ? !freshSnapshot || !validPoint(freshPoint, freshShot) || (record.grounded !== null &&
            (freshPoint?.role !== record.grounded.role || freshPoint?.name !== record.grounded.name))
          : !freshSnapshot;
        if (moved) {
          if (answer.approvalId) { try { await deps.approvals.markStale?.(answer.approvalId); } catch { /* the refusal stands */ } }
          steps.push(record);
          history.push(summarizeIntent(currentTurn, intent, "failed", "approval_stale"));
          if (!(await emit(intent, modelInfo, { ...receiptBase, result: "blocked", executed: false, code: "approval_stale" }))) { stop("receipt_error"); break; }
          stop("needs_owner", { type: "message", text: "I stopped because the page changed while I waited for your approval. Please check the page and ask me again." });
          break;
        }
        shot = freshShot;
        snapshot = freshSnapshot;
        point = freshPoint;
        record.grounded = point?.role !== undefined && point.name !== undefined ? { role: point.role, name: point.name } : null;
        record.groundingMethod = point?.method ?? null;
        receiptBase = { target: record.grounded, groundingMethod: record.groundingMethod, before: shot };
      }

      let afterShot = null as Screenshot | null;
      let emitted = false;
      try {
        const gate = await withinDeadline(confidenceGate({
          intent, point, before: shot, snapshot, desktop: deps.desktop, services, signal: runSignal,
        }));
        record.gate = gate.evidence;
        if (!gate.allowed) {
          steps.push(record);
          emitted = true;
          const blockedCode = gate.evidence[gate.evidence.length - 1]?.code ?? "blocked";
          if (!(await emit(intent, modelInfo, { ...receiptBase, gate: gate.evidence, result: "blocked", executed: false, code: astraAllowed ? "astra_allowed" : blockedCode }))) { stop("receipt_error"); break; }
          stop("needs_owner", { type: "message", text: "I stopped before input because independent target checks did not agree. Please take over this step." });
          break;
        }
        checkCancelled(runSignal);
        if (stopIfStopped()) break;
        await executeIntent(intent, deps.desktop, point, sleep);
        if (intent.action === "type") typedTail = (typedTail + intent.text).slice(-64);
        record.executed = true;
        steps.push(record);
        record.verification = await withinDeadline(verifyStep({
          desktop: deps.desktop, services, before: shot, expect: "expect" in intent ? intent.expect : "", signal: runSignal, sleep,
          onAfter: (value) => { afterShot = value; },
        }));
        record.verified = record.verification.status === "pass";
        // A page-structure check takes no screenshot; the receipt still needs the "after" picture.
        if (receipts && !afterShot) { try { afterShot = await deps.desktop.screenshot(); } catch { afterShot = null; } }
        emitted = true;
        if (!(await emit(intent, modelInfo, { ...receiptBase, gate: record.gate, verification: record.verification, after: afterShot, result: record.verification.status, executed: true, code: astraAllowed ? "astra_allowed" : undefined }))) { stop("receipt_error"); break; }
        if (stopIfStopped()) break;
        if (weightedTokens(usage) >= tokenLimit) { stop("token_limit"); break; }
        if (!record.verified) {
          stop("needs_owner", { type: "message", text: "The action was attempted, but its expected result was not verified. I stopped; please inspect the desktop before continuing." });
          break;
        }
      } catch (error) {
        if (record.executed && !record.verification) record.verification = { status: "unknown", sam: services.samState, evidence: [] };
        if (receipts && !emitted) {
          const code = errorCode(error);
          const safeCode = typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : "desktop_error";
          if (!(await emit(intent, modelInfo, { ...receiptBase, gate: record.gate, verification: record.verification, after: afterShot,
            result: record.executed ? record.verification?.status ?? "unknown" : "failed", executed: record.executed,
            code: astraAllowed ? "astra_allowed" : safeCode }))) { stop("receipt_error"); break; }
        }
        if (stopForCost(error) || stopIfStopped()) break;
        if (errorCode(error) === "security") { securityCause = "cancelled"; stop("security_stop"); break; }
        stop(errorCode(error) === "takeover_active" ? "paused_by_owner" : errorCode(error) === "aborted" ? "aborted" : "desktop_error");
        break;
      }
      history.push(summarizeIntent(currentTurn, intent));
    }

    // Sealed before the card appears. A failed seal leaves the run unsealed, which verification reports.
    if (receipts && started) { try { await receipts.seal(outcome, usageNow()); } catch { /* unsealed */ } }
    let cardPosted = false;
    if ((outcome as string) === "security_stop" && securityCause) {
      try {
        const handled = await deps.onSecurityStop?.({ step: steps.length, cause: securityCause });
        if (handled === "posted" || handled === "duplicate") cardPosted = true;
      } catch { /* fall through to the fixed card */ }
    }
    if (!card) card = { type: "message", text: FIXED_TEXT[outcome as keyof typeof FIXED_TEXT] };
    if (!cardPosted && !deps.silent) {
      try { await deps.postCard(card); cardPosted = true; } catch { /* the caller sees cardPosted: false */ }
    }
    return { outcome, steps, usage, cardPosted, ...(summary ? { summary } : {}), finalCard: card };
  } finally {
    if (deadline) clearTimeout(deadline);
    deps.signal?.removeEventListener("abort", onDependencyAbort);
    deps.subagents?.cancelAll();
    // TASK-073c. Cancellation or completion clears this run's push records. A failed cleanup is
    // bounded by the control timeout and by the proxy's own expiry; release follows either way.
    if (pushApprovalsCleared && typeof deps.shell?.clearApprovals === "function") {
      try { await deps.shell.clearApprovals(); } catch { /* expiry is the fallback */ }
    }
    // Held until the card is posted, so a second run cannot start mid-report.
    releaseAgent();
  }
}
