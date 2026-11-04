import { z } from "zod";

import { isValidKeyChord } from "../desktop/key-chord";
import { parseExpectation } from "../agent/verification";

// TASK-041. A replay script is what a verified run leaves behind once it is compiled from its signed receipts: the
// ordered steps, the control each click named (role and exact name) and a structural postcondition per desktop step.
// It holds no coordinates (re-derived from the live page every run), no typed text (supplied when the owner replays)
// and no model output. Names come from page text, so they are untrusted display and matching data only.
export const MAX_REPLAY_STEPS = 20;
export const MAX_REPLAY_NAME = 80;
export const MAX_INPUT_CHARS = 2000;

const noControls = (value: string) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value);
const text = (max: number) => z.string().min(1).max(max).refine(noControls, "no control characters");
// Only the three checks a page can answer without a model.
const structural = text(300).refine((value) => {
  const parsed = parseExpectation(value);
  return parsed !== null && parsed.kind !== "object_visible";
}, "postcondition must be control_present, control_absent or url_path");
const idx = z.number().int().min(1).max(MAX_REPLAY_STEPS);

const click = z.object({ idx, action: z.literal("click"), role: text(64), name: text(200), expect: structural }).strict();
const type = z.object({ idx, action: z.literal("type"), chars: z.number().int().min(1).max(MAX_INPUT_CHARS), expect: structural }).strict();
const key = z.object({ idx, action: z.literal("key"), keys: z.string().refine(isValidKeyChord, "not a valid key chord"), expect: structural }).strict();
const scroll = z.object({ idx, action: z.literal("scroll"), direction: z.enum(["up", "down"]), expect: structural }).strict();
const wait = z.object({ idx, action: z.literal("wait"), expect: structural }).strict();
const deliver = z.object({
  idx, action: z.literal("deliver_file"), from: z.enum(["downloads", "work"]),
  file: text(255).refine((value) => !/[/\\]/.test(value) && !value.startsWith("."), "plain file name"),
}).strict();

export const replayStepSchema = z.discriminatedUnion("action", [click, type, key, scroll, wait, deliver]);
export type ReplayStep = z.infer<typeof replayStepSchema>;

export const replayStepsSchema = z.array(replayStepSchema).min(1).max(MAX_REPLAY_STEPS)
  .refine((list) => list.every((step, i) => step.idx === i + 1), "steps are numbered 1..n in order");

export type CompileCode =
  | "no_steps" | "too_many_steps" | "receipt_unreadable" | "step_not_verified" | "step_not_replayable"
  | "postcondition_not_structural" | "control_unknown" | "run_not_verified" | "chain_invalid" | "audio_not_replayable";
export interface CompileReason { step: number | null; code: CompileCode }
export type CompileResult = { ok: true; steps: ReplayStep[] } | { ok: false; reasons: CompileReason[] };

const receiptSchema = z.object({
  idx: z.number().int().min(1),
  action: z.object({ kind: z.string().max(40) }).passthrough(),
  target: z.object({ role: z.string().max(200), name: z.string().max(400) }).nullable().optional(),
  postcondition: z.string().max(600).optional(),
  result: z.string().max(20).optional(),
  executed: z.boolean().optional(),
}).passthrough();

const MAX_REASONS = 10;

// Pure. `receipts` are the stored canonical receipt texts of one run, in order. The caller has already checked that the
// run is sealed, finished and chain-verified; this only decides whether each step can be replayed without a model.
export function compileFromReceipts(receipts: readonly { idx: number; receipt: string }[]): CompileResult {
  const reasons: CompileReason[] = [];
  const add = (step: number | null, code: CompileCode) => { if (reasons.length < MAX_REASONS) reasons.push({ step, code }); };
  if (receipts.length === 0) return { ok: false, reasons: [{ step: null, code: "no_steps" }] };
  if (receipts.length > MAX_REPLAY_STEPS) return { ok: false, reasons: [{ step: null, code: "too_many_steps" }] };

  const compiled: ReplayStep[] = [];
  for (const row of receipts) {
    let receipt: z.infer<typeof receiptSchema>;
    try {
      const parsed = receiptSchema.safeParse(JSON.parse(row.receipt));
      if (!parsed.success) { add(row.idx, "receipt_unreadable"); continue; }
      receipt = parsed.data;
    } catch { add(row.idx, "receipt_unreadable"); continue; }

    if (!((receipt.result === "pass" || receipt.result === "executed") && receipt.executed === true)) { add(row.idx, "step_not_verified"); continue; }
    const action = receipt.action as { kind: string; keys?: unknown; direction?: unknown; chars?: unknown; from?: unknown; name?: unknown };
    // TASK-054. A memory request is not a screen step; a replay skips it instead of failing to compile.
    if (action.kind === "remember") continue;
    const expect = receipt.postcondition ?? "";
    const n = compiled.length + 1;
    let candidate: unknown;
    switch (action.kind) {
      case "click":
        if (!receipt.target?.role || !receipt.target.name) { add(row.idx, "control_unknown"); continue; }
        candidate = { idx: n, action: "click", role: receipt.target.role, name: receipt.target.name, expect };
        break;
      case "type": candidate = { idx: n, action: "type", chars: action.chars, expect }; break;
      case "key": candidate = { idx: n, action: "key", keys: action.keys, expect }; break;
      case "scroll": candidate = { idx: n, action: "scroll", direction: action.direction, expect }; break;
      case "wait": candidate = { idx: n, action: "wait", expect }; break;
      case "deliver_file": candidate = { idx: n, action: "deliver_file", from: action.from, file: action.name }; break;
      // TASK-079. Hearing is a paid live capture; a replay must stop before executing or spending anything.
      case "hear_audio": add(row.idx, "audio_not_replayable"); continue;
      default: add(row.idx, "step_not_replayable"); continue;
    }
    const step = replayStepSchema.safeParse(candidate);
    if (step.success) { compiled.push(step.data); continue; }
    // The postcondition is the one field a perfectly good run can get wrong (prose or object_visible); say so.
    const onlyExpect = step.error.issues.every((issue) => issue.path[0] === "expect");
    add(row.idx, onlyExpect ? "postcondition_not_structural" : "step_not_replayable");
  }
  if (reasons.length) return { ok: false, reasons };
  if (!compiled.length) return { ok: false, reasons: [{ step: null, code: "no_steps" }] };
  return { ok: true, steps: compiled };
}

// Which compiled steps need text from the owner at replay time, and the exact input keys the run route accepts.
export const inputKeysOf = (steps: readonly ReplayStep[]): string[] => steps.filter((step) => step.action === "type").map((step) => String(step.idx));

export const replayInputsSchema = z.record(z.string().regex(/^\d{1,2}$/), z.string().min(1).max(MAX_INPUT_CHARS)
  .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), "unsupported control characters")).default({});

// The owner must supply exactly one value per `type` step. Returns the values by step index, or null on any mismatch.
export function matchInputs(steps: readonly ReplayStep[], supplied: Readonly<Record<string, string>>): Map<number, string> | null {
  const wanted = inputKeysOf(steps);
  const given = Object.keys(supplied);
  if (given.length !== wanted.length || !wanted.every((key) => key in supplied)) return null;
  return new Map(wanted.map((key) => [Number(key), supplied[key]]));
}

export function defaultScriptName(task: string): string {
  const cleaned = task.replace(/^Replay:\s*/i, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return (cleaned || "Saved replay").slice(0, MAX_REPLAY_NAME);
}

export const scriptNameSchema = z.string().trim().min(1).max(MAX_REPLAY_NAME).refine(noControls, "no control characters");
