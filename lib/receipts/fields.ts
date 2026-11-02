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
  | { kind: "type"; chars: number }
  | { kind: "key"; keys: string }
  | { kind: "scroll"; direction: "up" | "down" }
  | { kind: "wait" }
  | { kind: "read_document"; name: string; offset: number }
  | { kind: "deliver_file"; from: "downloads" | "work"; name: string }
  // TASK-054. Only the scope and character count: the memory text itself never enters a receipt.
  | { kind: "remember"; scope: "global" | "agent" | "private"; chars: number }
  // TASK-072. The tool name, an argument hash and its size; never the arguments or the result.
  | { kind: "tool_call"; server: string; tool: string; args_sha256: string; args_bytes: number }
  // TASK-073. The program name, a hash and size of the command, cwd, exit code and timeout flag; never the command or output.
  | { kind: "shell"; program: string; command_sha256: string; command_bytes: number; cwd: string; exit: number | null; timeout: boolean };

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

// Typed text is never kept (only its length); file contents are never kept (only names). Page text is bounded.
export function actionFor(intent: Intent): ReceiptAction | null {
  switch (intent.action) {
    case "click": return { kind: "click", target: cleanText(intent.target, 200) };
    case "type": return { kind: "type", chars: [...intent.text].length };
    case "key": return { kind: "key", keys: cleanText(intent.keys, 64) };
    case "scroll": return { kind: "scroll", direction: intent.direction };
    case "wait": return { kind: "wait" };
    case "read_document": return { kind: "read_document", name: cleanText(intent.name, 255), offset: intent.offset ?? 0 };
    case "deliver_file": return { kind: "deliver_file", from: intent.from, name: cleanText(intent.name, 255) };
    case "remember": return { kind: "remember", scope: intent.scope, chars: [...intent.text].length };
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
    case "shell": return {
      kind: "shell",
      program: cleanText(intent.command.trim().split(/[ \t]+/)[0]?.split("/").pop() ?? "", 64),
      command_sha256: sha256Hex(Buffer.from(intent.command, "utf8")),
      command_bytes: Buffer.byteLength(intent.command, "utf8"),
      cwd: cleanText(intent.cwd ?? "work", 255),
      exit: null,
      timeout: false,
    };
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
  if (action.kind === "read_document" || action.kind === "deliver_file" || action.kind === "remember" || action.kind === "tool_call" || action.kind === "shell") return "none";
  if (result !== "pass" || methods.some((item) => item.status === "fail")) return "low";
  const passing = new Set(methods.filter((item) => item.status === "pass").map((item) => item.method));
  return passing.size >= 2 ? "high" : passing.size === 1 ? "medium" : "low";
}
