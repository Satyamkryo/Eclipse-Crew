import { z } from "zod";

// TASK-031. Pure helpers that turn stored receipts into what the History tab shows. No server-only import: client
// components share the types and labels. Every string that came from a page or the owner is untrusted display text.
export type ChainState =
  | { state: "verified" }
  | { state: "unsealed" }
  | { state: "failed"; reason: string; step: number | null };

export type RunTone = "success" | "danger" | "warning" | "neutral";
export interface RunSummary {
  runId: string;
  task: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  stepCount: number;
  label: string;
  tone: RunTone;
  // true when the run finished and every recorded desktop step passed its check
  verified: boolean;
  // TASK-043: from the signed header. null for an original run.
  branch: { runId: string; step: number } | null;
}

export interface SamBoxView { x1: number; y1: number; x2: number; y2: number; width: number; height: number }
export interface StepView {
  idx: number;
  action: string;
  target: string | null;
  result: string;
  tone: RunTone;
  confidence: string;
  method: string;
  sam: string;
  model: string;
  postcondition: string;
  code: string | null;
  costMicroUsd: number | null;
  receiptHash: string;
  prevHash: string;
  // Hashes of stored screenshots that match the signed receipt, or null. The images load from the evidence route.
  beforeImage: string | null;
  afterImage: string | null;
  // none: the step took no screenshots (file action). missing: the receipt names screenshots that are not stored (or differ).
  screens: "none" | "stored" | "missing";
  imageWidth: number | null;
  imageHeight: number | null;
  samBox: SamBoxView | null;
  // TASK-032: whether a full checkpoint (state and files) was saved after this step, so a later rewind can use it.
  checkpoint: "saved" | "partial" | "missing";
  checkpointReason: string | null;
}
export interface RunDetail {
  run: RunSummary; agentId: string; keyId: string; chain: ChainState; steps: StepView[]; branches: RunSummary[];
  // TASK-043: the baseline checkpoint (idx 0, "before step 1"), which has no step row of its own.
  baselineCheckpoint: "saved" | "partial" | "missing";
}

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const receiptSchema = z.object({
  idx: z.number().int(),
  model_label: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  action: z.object({ kind: z.string().max(40) }).passthrough(),
  target: z.object({ role: z.string().max(200), name: z.string().max(400) }).nullable().optional(),
  methods: z.array(z.object({ phase: z.string(), method: z.string().max(40), status: z.string().max(20) }).passthrough()).max(20).optional(),
  sam: z.string().max(20).optional(),
  confidence: z.string().max(20).optional(),
  before_hash: hash.nullable().optional(),
  after_hash: hash.nullable().optional(),
  postcondition: z.string().max(600).optional(),
  result: z.string().max(20).optional(),
  code: z.string().max(80).nullable().optional(),
  cost_micro_usd: z.number().int().min(0).nullable().optional(),
}).passthrough();

const METHOD_NAME: Record<string, string> = { page_structure: "Page structure", sam: "SAM 3.1", model: "Model check" };
const SAM_NOTE: Record<string, string> = { off: "SAM off", unavailable: "SAM unavailable", on: "SAM on" };

export function actionLabel(action: Record<string, unknown>): { text: string; target: string | null } {
  const text = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);
  switch (action.kind) {
    case "click": return { text: "Click", target: text(action.target) || null };
    case "type": return { text: `Type ${typeof action.chars === "number" ? action.chars : 0} characters`, target: null };
    case "key": return { text: `Press ${text(action.keys)}`, target: null };
    case "scroll": return { text: `Scroll ${text(action.direction)}`, target: null };
    case "wait": return { text: "Wait", target: null };
    case "read_document": return { text: "Read document", target: text(action.name) || null };
    case "deliver_file": return { text: "Send file", target: text(action.name) || null };
    case "remember": return { text: "Ask to remember", target: text(action.scope) || null };
    case "tool_call": return { text: "External action", target: `${text(action.server)}.${text(action.tool)}` || null };
    case "shell": return { text: "Shell command", target: text(action.program) || null };
    default: return { text: "Step", target: null };
  }
}

export function methodLabel(methods: readonly { phase: string; method: string; status: string }[], sam: string, kind: string): string {
  if (kind === "read_document" || kind === "deliver_file") return "File action, no screen check";
  if (kind === "remember") return "Memory request, no screen check";
  if (kind === "tool_call") return "Tool call, no screen check";
  if (kind === "shell") return "Shell command, no screen check";
  const passed = [...new Set(methods.filter((item) => item.status === "pass").map((item) => METHOD_NAME[item.method] ?? "Check"))];
  const base = passed.length ? passed.join(" + ") : "No check passed";
  return passed.includes("SAM 3.1") ? base : `${base} (${SAM_NOTE[sam] ?? "SAM off"})`;
}

const resultTone = (result: string): RunTone =>
  result === "pass" || result === "executed" ? "success" : result === "fail" || result === "failed" || result === "blocked" ? "danger" : "warning";

export interface EvidenceRowView {
  beforeHash: string | null; afterHash: string | null; width: number | null; height: number | null; samBox: unknown;
}
const samBoxSchema = z.object({
  x1: z.number().min(0).max(100_000), y1: z.number().min(0).max(100_000), x2: z.number().min(0).max(100_000), y2: z.number().min(0).max(100_000),
  width: z.number().int().min(1).max(100_000), height: z.number().int().min(1).max(100_000),
});

// A malformed stored receipt becomes a plain placeholder row instead of breaking the whole timeline.
export interface CheckpointRowView { status: "complete" | "partial"; reason: string | null }
export function viewStep(receiptText: string, receiptHash: string, prevHash: string, idx: number, evidence: EvidenceRowView | null, checkpoint: CheckpointRowView | null = null): StepView {
  const saved = { checkpoint: (checkpoint ? (checkpoint.status === "complete" ? "saved" : "partial") : "missing") as StepView["checkpoint"],
    checkpointReason: checkpoint?.reason && /^[a-z_]{1,64}$/.test(checkpoint.reason) ? checkpoint.reason : null };
  let parsed: z.infer<typeof receiptSchema> | null = null;
  try { const value = receiptSchema.safeParse(JSON.parse(receiptText)); parsed = value.success ? value.data : null; } catch { parsed = null; }
  if (!parsed) {
    return { idx, action: "Step could not be read", target: null, result: "unknown", tone: "warning", confidence: "low", method: "Unknown",
      sam: "off", model: "", postcondition: "", code: null, costMicroUsd: null, receiptHash, prevHash,
      beforeImage: null, afterImage: null, screens: "none", imageWidth: null, imageHeight: null, samBox: null, ...saved };
  }
  const label = actionLabel(parsed.action);
  const sam = parsed.sam ?? "off";
  const result = parsed.result ?? "unknown";
  // An image is shown only if the stored file is the one the signed receipt names.
  const beforeImage = evidence?.beforeHash && evidence.beforeHash === parsed.before_hash ? evidence.beforeHash : null;
  const afterImage = evidence?.afterHash && evidence.afterHash === parsed.after_hash ? evidence.afterHash : null;
  const box = samBoxSchema.safeParse(evidence?.samBox);
  return {
    idx, action: label.text, target: parsed.target?.name ?? label.target, result, tone: resultTone(result),
    confidence: parsed.confidence ?? "low", method: methodLabel(parsed.methods ?? [], sam, parsed.action.kind), sam,
    model: parsed.model_label ?? parsed.model ?? "", postcondition: parsed.postcondition ?? "", code: parsed.code ?? null,
    costMicroUsd: parsed.cost_micro_usd ?? null, receiptHash, prevHash, beforeImage, afterImage,
    screens: !parsed.before_hash && !parsed.after_hash ? "none" : beforeImage || afterImage ? "stored" : "missing",
    imageWidth: evidence?.width ?? null, imageHeight: evidence?.height ?? null,
    // The outline is drawn only on the "after" image, only when SAM passed.
    samBox: box.success && afterImage ? box.data : null,
    ...saved,
  };
}

const RUN_LABEL: Record<string, { label: string; tone: RunTone }> = {
  finished: { label: "Finished", tone: "success" },
  asked_owner: { label: "Asked you", tone: "neutral" },
  needs_owner: { label: "Needs you", tone: "warning" },
  security_stop: { label: "Security stop", tone: "danger" },
  scope_blocked: { label: "Blocked: outside task", tone: "warning" },
  paused_by_owner: { label: "Paused", tone: "warning" },
};
const RUNNING_WINDOW_MS = 15 * 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function summarizeRun(input: {
  runId: string; headerText: string; startedAt: Date; endedAt: Date | null; sealed: boolean; status: string; stepResults: readonly string[]; now?: Date;
}): RunSummary {
  let task = "";
  let branch: RunSummary["branch"] = null;
  try {
    const header = JSON.parse(input.headerText) as { task?: unknown; branch_of?: unknown; branch_at?: unknown };
    task = typeof header.task === "string" ? header.task.slice(0, 2000) : "";
    if (typeof header.branch_of === "string" && UUID_PATTERN.test(header.branch_of) &&
        Number.isSafeInteger(header.branch_at) && (header.branch_at as number) >= 0) {
      branch = { runId: header.branch_of, step: header.branch_at as number };
    }
  } catch { task = ""; }
  const now = input.now ?? new Date();
  let entry: { label: string; tone: RunTone };
  if (!input.sealed) {
    entry = now.getTime() - input.startedAt.getTime() < RUNNING_WINDOW_MS ? { label: "Running", tone: "neutral" } : { label: "Not sealed", tone: "warning" };
  } else entry = RUN_LABEL[input.status] ?? { label: "Stopped", tone: "danger" };
  const checked = input.stepResults.length > 0 && input.stepResults.every((result) => result === "pass" || result === "executed");
  const verified = input.sealed && input.status === "finished" && checked;
  return {
    runId: input.runId, task, startedAt: input.startedAt.toISOString(), endedAt: input.endedAt?.toISOString() ?? null,
    durationMs: input.endedAt ? Math.max(0, input.endedAt.getTime() - input.startedAt.getTime()) : null,
    stepCount: input.stepResults.length, label: verified ? "Verified" : entry.label, tone: verified ? "success" : entry.tone, verified, branch,
  };
}

export function stepResultOf(receiptText: string): string {
  try { const value = JSON.parse(receiptText) as { result?: unknown }; return typeof value.result === "string" ? value.result : "unknown"; } catch { return "unknown"; }
}
