import { cleanText, sha256Hex } from "./chain.mjs";
import type { Intent } from "../agent/intent";
import type { Evidence, SamState, Verification } from "../agent/verification";

// What the step loop hands to a receipt recorder. The recorder adds the run id, agent id, time, version and prev_hash.
export type ReceiptResult = "pass" | "fail" | "unknown" | "blocked" | "executed" | "failed";
export type Confidence = "high" | "medium" | "low" | "none";

export interface ReceiptUsage { input: number; output: number; cached: number; reasoning: number }
export interface ReceiptMethod { phase: "gate" | "verify"; method: Evidence["method"]; status: Evidence["status"]; code: string }

export type ReceiptAction =
  | { kind: "click"; target: string }
  // ADR-041. The model-chosen point and its description.
  | { kind: "click_at"; x: number; y: number; target: string; button?: "right" | "double"; landed?: { x: number; y: number } }
  // ADR-042. Also model-chosen points; never replayable.
  | { kind: "drag_at"; x: number; y: number; to_x: number; to_y: number; target: string }
  | { kind: "scroll_at"; x: number; y: number; direction: "up" | "down" | "left" | "right"; target: string }
  // TASK-084: `values` lists the saved-value names inserted into the text, never the values.
  | { kind: "type"; chars: number; values: string[] }
  | { kind: "key"; keys: string }
  | { kind: "scroll"; direction: "up" | "down" }
  | { kind: "wait" }
  | { kind: "read_document"; name: string; offset: number }
  // TASK-082. The file, the query length and the hit count; never the query text or passage text.
  | { kind: "search_document"; name: string; chars: number; hits: number }
  // TASK-086. Chat-history search: the query length and hit count only.
  | { kind: "search_history"; chars: number; hits: number }
  | { kind: "deliver_file"; from: "downloads" | "work"; name: string }
  // TASK-084. Names and lengths only: the saved text, the host and the option are never stored.
  | { kind: "extract"; name: string; chars: number }
  | { kind: "navigate"; host: string }
  | { kind: "select"; target: string; option_chars: number }
  // TASK-054. Only the scope and character count: the memory text itself never enters a receipt.
  | { kind: "remember"; op: "add" | "replace" | "forget"; scope: "global" | "agent" | "private"; chars: number }
  // TASK-072. The tool name, an argument hash and its size; never the arguments or the result.
  | { kind: "tool_call"; server: string; tool: string; args_sha256: string; args_bytes: number }
  // TASK-073. The program name, a hash and size of the command, cwd, exit code and timeout flag; never the command or output.
  | { kind: "shell"; program: string; command_sha256: string; command_bytes: number; cwd: string; exit: number | null; timeout: boolean }
  // TASK-079. Requested and actual duration, audio hash/size and the fixed transcription model; never the audio or transcript.
  | { kind: "hear_audio"; seconds: number; chars: number; duration_ms: number; audio_sha256: string; audio_bytes: number; transcribe_model: string }
  // Lifecycle steps record only the verified resulting states, never an executable, identity or path.
  | { kind: "start_desktop"; graphics: string; browser: string }
  | { kind: "start_browser"; graphics: string; browser: string }
  // TASK-085. The teammate name and the note's length; never the note text.
  | { kind: "handoff"; agent: string; chars: number }
  // TASK-076. How many screenless tools the helper was granted and the task's length; never the task text.
  | { kind: "spawn_subagent"; tools: number; chars: number };

export interface ReceiptInput {
  idx: number;
  model: string;
  model_label: string;
  route: string;
  action: ReceiptAction;
  target: { role: string; name: string } | null;
  grounding_method: string | null;
  methods: ReceiptMethod[];
  sam: SamState;
  confidence: Confidence;
  before_hash: string | null;
  after_hash: string | null;
  postcondition: string;
  result: ReceiptResult;
  code: string | null;
  executed: boolean;
  usage: ReceiptUsage;
  // Whole micro-USD attributed to this step from the append-only cost ledger; null only when cost tracking is not enabled.
  cost_micro_usd: number | null;
}

// The step loop's only view of the proof store. Tests inject a fake; production is lib/receipts/store.ts.
export interface ReceiptSink {
  readonly runId: string;
  begin(): Promise<void>;
  step(input: ReceiptInput): Promise<void>;
  // Seals the run with the final outcome and total usage. Called once.
  seal(status: string, usage: ReceiptUsage): Promise<void>;
}

const hostOf = (url: string) => { try { return new URL(url).host; } catch { return ""; } };

// Typed text is never kept (only its length); file contents are never kept (only names). Page text is bounded.
export function actionFor(intent: Intent): ReceiptAction | null {
  switch (intent.action) {
    case "click": return { kind: "click", target: cleanText(intent.target, 200) };
    case "click_at": return { kind: "click_at", x: intent.x, y: intent.y, target: cleanText(intent.target, 200), ...(intent.button && intent.button !== "left" ? { button: intent.button } : {}) };
    case "drag_at": return { kind: "drag_at", x: intent.x, y: intent.y, to_x: intent.to_x, to_y: intent.to_y, target: cleanText(intent.target, 200) };
    case "scroll_at": return { kind: "scroll_at", x: intent.x, y: intent.y, direction: intent.direction, target: cleanText(intent.target, 200) };
    case "type": return { kind: "type", chars: [...intent.text].length, values: [] };
    case "key": return { kind: "key", keys: cleanText(intent.keys, 64) };
    case "scroll": return { kind: "scroll", direction: intent.direction };
    case "wait": return { kind: "wait" };
    case "read_document": return { kind: "read_document", name: cleanText(intent.name, 255), offset: intent.offset ?? 0 };
    // The hit count arrives from the step loop on the receipt, not from the intent.
    case "search_document": return { kind: "search_document", name: cleanText(intent.name, 255), chars: [...intent.query].length, hits: 0 };
    case "search_history": return { kind: "search_history", chars: [...intent.query].length, hits: 0 };
    case "deliver_file": return { kind: "deliver_file", from: intent.from, name: cleanText(intent.name, 255) };
    case "extract": return { kind: "extract", name: cleanText(intent.name, 32), chars: [...intent.value].length };
    case "navigate": return { kind: "navigate", host: cleanText(hostOf(intent.url), 255) };
    case "select": return { kind: "select", target: cleanText(intent.target, 200), option_chars: [...intent.option].length };
    case "remember": return { kind: "remember", op: intent.op, scope: intent.scope, chars: [...(intent.text ?? "")].length };
    case "tool_call": {
      const dot = intent.name.indexOf(".");
      return {
        kind: "tool_call",
        server: cleanText(intent.name.slice(0, dot), 32),
        tool: cleanText(intent.name.slice(dot + 1), 128),
        args_sha256: sha256Hex(Buffer.from(intent.args, "utf8")),
        args_bytes: Buffer.byteLength(intent.args, "utf8"),
      };
    }
    case "start_desktop": return { kind: "start_desktop", graphics: "unknown", browser: "unknown" };
    case "start_browser": return { kind: "start_browser", graphics: "unknown", browser: "unknown" };
    case "shell": return {
      kind: "shell",
      program: cleanText(intent.command.trim().split(/[ \t]+/)[0]?.split("/").pop() ?? "", 64),
      command_sha256: sha256Hex(Buffer.from(intent.command, "utf8")),
      command_bytes: Buffer.byteLength(intent.command, "utf8"),
      cwd: cleanText(intent.cwd ?? "work", 255),
      exit: null,
      timeout: false,
    };
    case "hear_audio": return { kind: "hear_audio", seconds: intent.seconds ?? 10, chars: 0, duration_ms: 0, audio_sha256: "", audio_bytes: 0, transcribe_model: "" };
    case "handoff": return { kind: "handoff", agent: cleanText(intent.agent, 80), chars: [...intent.note].length };
    case "spawn_subagent": return { kind: "spawn_subagent", tools: intent.tools.length, chars: [...intent.task].length };
    default: return null;
  }
}

export function screenshotHash(base64: string | undefined): string | null {
  if (!base64) return null;
  const bytes = Buffer.from(base64, "base64");
  return bytes.length ? sha256Hex(bytes) : null;
}

export function methodsFor(gate: readonly Evidence[] | undefined, verification: Verification | undefined): ReceiptMethod[] {
  const map = (phase: ReceiptMethod["phase"], list: readonly Evidence[]) =>
    list.map((item) => ({ phase, method: item.method, status: item.status, code: cleanText(item.code, 64) }));
  return [...map("gate", gate ?? []), ...map("verify", verification?.evidence ?? [])];
}

// high: two or more different methods passed and none failed. medium: one passed and none failed. low: anything else,
// including every step whose result is not "pass". none: file actions, which have no verification.
export function confidenceFor(action: ReceiptAction, result: ReceiptResult, methods: readonly ReceiptMethod[]): Confidence {
  if (action.kind === "read_document" || action.kind === "search_document" || action.kind === "search_history" || action.kind === "deliver_file" || action.kind === "extract" ||
    action.kind === "remember" || action.kind === "tool_call" || action.kind === "shell" || action.kind === "start_desktop" || action.kind === "start_browser" ||
    action.kind === "hear_audio" || action.kind === "handoff" || action.kind === "spawn_subagent") return "none";
  if (result !== "pass" || methods.some((item) => item.status === "fail")) return "low";
  const passing = new Set(methods.filter((item) => item.status === "pass").map((item) => item.method));
  return passing.size >= 2 ? "high" : passing.size === 1 ? "medium" : "low";
}
