import { z } from "zod";

import type { StepSummary } from "../agent/context";
import type { Intent } from "../agent/intent";
import { canonicalJson } from "../receipts/chain.mjs";

// TASK-032. What a checkpoint remembers about the agent's run: exactly the information the model already sees (the owner's
// task, the short step history, which documents were read) plus the loop's counters, so a later rewind (TASK-043) can resume
// without replaying earlier steps. It never holds typed text, screenshots, document contents, keys or tokens.
export const MAX_STATE_BYTES = 256 * 1024;

const count = z.number().int().min(0).max(1_000_000_000);
const shortText = (max: number) => z.string().max(max).refine((value) => !/[\u0000-\u001f\u007f-\u009f]/.test(value));
const summarySchema = z.object({
  step: z.number().int().min(1).max(10_000),
  action: z.string().min(1).max(40),
  target: z.string().max(500).optional(),
  expect: z.string().max(500).optional(),
  chars: count.optional(),
  time: z.string().max(200).optional(),
  file: z.string().max(255).optional(),
  offset: count.optional(),
  code: z.string().max(64).optional(),
  result: z.enum(["executed", "invalid_output", "target_not_found", "failed"]),
}).strict();

export const checkpointStateSchema = z.object({
  v: z.literal(1),
  task: z.string().min(1).max(2000),
  turn: count,
  receiptIdx: count,
  history: z.array(summarySchema).max(200),
  // Contents are not kept; the file is read again on resume.
  documents: z.array(z.object({ name: shortText(255), offset: count }).strict()).max(20),
  delivered: z.array(shortText(255)).max(100),
  counters: z.object({ invalid: count, repeats: count, misses: count, hardTurns: count, hardDisabled: z.boolean() }).strict(),
  // The previous intent in a form that is safe to keep: typed text is replaced by its length.
  previous: z.string().max(2000).nullable(),
  usage: z.object({ input: count, output: count, cached: count, reasoning: count }).strict(),
}).strict();
export type CheckpointState = z.infer<typeof checkpointStateSchema>;

// The intent with anything typed removed, as stable text. Used only to tell "same step again" apart after a resume.
export function safeIntentKey(intent: Intent | null): string | null {
  if (!intent) return null;
  const copy: Record<string, unknown> = { ...intent };
  if (intent.action === "type") copy.text = `[${[...intent.text].length} characters]`;
  return canonicalJson(copy).slice(0, 2000);
}

export interface LoopSnapshot {
  task: string;
  turn: number;
  receiptIdx: number;
  history: readonly StepSummary[];
  documents: readonly { name: string; window: { kind: string; offset?: number } }[];
  delivered: readonly string[];
  counters: CheckpointState["counters"];
  previous: Intent | null;
  usage: CheckpointState["usage"];
}

// Builds the stored form. Throws (Zod) if anything is out of bounds, so an oversized or odd state is never half-saved.
export function captureState(snapshot: LoopSnapshot): { text: string; state: CheckpointState } {
  const state = checkpointStateSchema.parse({
    v: 1, task: snapshot.task.slice(0, 2000), turn: snapshot.turn, receiptIdx: snapshot.receiptIdx,
    history: snapshot.history.map((item) => ({ ...item })).slice(-200),
    documents: snapshot.documents.map((item) => ({ name: item.name, offset: item.window.offset ?? 0 })).slice(-20),
    delivered: [...snapshot.delivered].slice(-100), counters: snapshot.counters,
    previous: safeIntentKey(snapshot.previous), usage: snapshot.usage,
  });
  const text = canonicalJson(state);
  if (Buffer.byteLength(text) > MAX_STATE_BYTES) throw new Error("state_too_large");
  return { text, state };
}

// For restore: unknown fields, wrong types and oversized input are all refused.
export function parseState(text: string): CheckpointState | null {
  if (Buffer.byteLength(text) > MAX_STATE_BYTES) return null;
  try { const parsed = checkpointStateSchema.safeParse(JSON.parse(text)); return parsed.success ? parsed.data : null; } catch { return null; }
}
