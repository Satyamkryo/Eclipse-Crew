import "server-only";
import { z } from "zod";
import { isValidKeyChord } from "../desktop/key-chord";
import type { ProviderOutput, ProviderTool } from "../providers/types";

// Models never emit coordinates or selectors (ADR-008). Every schema is strict, so an extra
// `x`, `y`, `coordinate` or `selector` field makes the whole step invalid.
const noControls = (value: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const line = (max: number) => z.string().trim().min(1).max(max).refine(
  (value) => !/[\u0000-\u001f\u007f]/.test(value), "must be a single line without control characters");
const target = line(200);
const expectation = line(300);

const click = z.object({ action: z.literal("click"), target, expect: expectation }).strict();
const type = z.object({
  action: z.literal("type"),
  text: z.string().min(1).max(2000).refine(noControls, "contains unsupported control characters"),
  expect: expectation,
}).strict();
const key = z.object({ action: z.literal("key"), keys: z.string().refine(isValidKeyChord, "not a valid key chord"), expect: expectation }).strict();
const scroll = z.object({ action: z.literal("scroll"), direction: z.enum(["up", "down"]), expect: expectation }).strict();
const wait = z.object({ action: z.literal("wait"), expect: expectation }).strict();
const getTime = z.object({ action: z.literal("get_time"), timezone: line(64).optional() }).strict();
// A final answer may be several lines (an answer about a document), so it is not a single-line field.
const answer = z.string().trim().min(1).max(4000).refine(noControls, "contains unsupported control characters");
const finish = z.object({ action: z.literal("finish"), summary: answer }).strict();
// File names come from the desktop listing and are checked again there; plain names only.
const fileName = z.string().min(1).max(255).refine((value) => !/[\u0000-\u001f\u007f-\u009f/\\]/.test(value) && !value.startsWith("."), "must be a plain file name");
const readDocument = z.object({ action: z.literal("read_document"), name: fileName, offset: z.number().int().min(0).max(5_000_000).optional(), expect: expectation }).strict();
const deliverFile = z.object({ action: z.literal("deliver_file"), from: z.enum(["downloads", "work"]), name: fileName, expect: expectation }).strict();
const askOwner = z.object({ action: z.literal("ask_owner"), question: line(1000) }).strict();

export const intentSchema = z.discriminatedUnion("action", [click, type, key, scroll, wait, getTime, readDocument, deliverFile, finish, askOwner]);
export type Intent = z.infer<typeof intentSchema>;
export type ClickIntent = Extract<Intent, { action: "click" }>;

// Actions that act on the desktop (and the file actions) need an entry in the agent's `actions`. The lists live in
// lib/agents/actions.ts so the agent form can show the same names.
export { DESKTOP_ACTIONS, FILE_ACTIONS } from "../agents/actions";

export const NEXT_STEP_TOOL_NAME = "next_step";
export const NEXT_STEP_TOOL: ProviderTool = {
  name: NEXT_STEP_TOOL_NAME,
  description: "Choose the single next step. Describe the target in words; never give coordinates or selectors.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["click", "type", "key", "scroll", "wait", "get_time", "read_document", "deliver_file", "finish", "ask_owner"] },
      name: { type: "string", description: "read_document / deliver_file: the exact file name from the file list." },
      offset: { type: "number", description: "read_document: character offset of the window to read; use next_offset from the previous window. Leave out to start at 0." },
      from: { type: "string", enum: ["downloads", "work"], description: "deliver_file: the folder the file is in." },
      timezone: { type: "string", description: "get_time: an IANA timezone such as America/New_York. Leave out for the owner's timezone." },
      target: { type: "string", description: "click: the element to click, in words (for example \"Submit button\")." },
      text: { type: "string", description: "type: the literal text to type into the focused field." },
      keys: { type: "string", description: "key: a key or chord such as Enter or Control+L." },
      direction: { type: "string", enum: ["up", "down"], description: "scroll: direction." },
      expect: { type: "string", description: "Expected result. Prefer control_present: Name, control_absent: Name, url_path: /path, or object_visible: concept; otherwise describe a visible postcondition." },
      summary: { type: "string", description: "finish: your answer or what you did (up to 4000 characters, line breaks allowed), only what the screen or a document shows." },
      question: { type: "string", description: "ask_owner: what you need from the owner." },
    },
  },
};

export type ParsedStep = { ok: true; intent: Intent } | { ok: false };

// Accepts exactly one `next_step` function call. Anything else is invalid and never executed.
export function parseNextStep(outputs: ProviderOutput[]): ParsedStep {
  const calls = outputs.filter((output) => output.type === "function_call" || output.type === "computer_call");
  if (calls.length !== 1) return { ok: false };
  const call = calls[0];
  if (call.type !== "function_call" || call.name !== NEXT_STEP_TOOL_NAME || call.arguments.length > 8192) return { ok: false };
  let raw: unknown;
  try { raw = JSON.parse(call.arguments); } catch { return { ok: false }; }
  const parsed = intentSchema.safeParse(raw);
  return parsed.success ? { ok: true, intent: parsed.data } : { ok: false };
}
