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
// TASK-082. Search returns passages, never the file. It uses the read_document permission.
const searchDocument = z.object({
  action: z.literal("search_document"), name: fileName,
  query: z.string().trim().min(1).max(200).refine(noControls, "contains unsupported control characters"),
  expect: expectation,
}).strict();
const deliverFile = z.object({ action: z.literal("deliver_file"), from: z.enum(["downloads", "work"]), name: fileName, expect: expectation }).strict();
// TASK-086. Search the agent's own chat history. Allowed with the remember permission; snippets are data.
const searchHistory = z.object({ action: z.literal("search_history"), query: line(200), expect: expectation }).strict();
// TASK-084. A value name is a short lowercase identifier, reusable as {{name}} in one later type step.
const valueName = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, "use a short lowercase name such as headline");
const extract = z.object({
  action: z.literal("extract"),
  name: valueName,
  value: z.string().trim().min(1).max(2000).refine(noControls, "contains unsupported control characters"),
  expect: expectation,
}).strict();
const httpUrl = (value: string) => {
  try { const url = new URL(value); return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password; } catch { return false; }
};
const navigate = z.object({ action: z.literal("navigate"), url: z.string().trim().min(1).max(2048).refine(httpUrl, "use an http(s) URL without credentials"), expect: expectation }).strict();
const select = z.object({ action: z.literal("select"), target, option: line(200), expect: expectation }).strict();
const askOwner = z.object({ action: z.literal("ask_owner"), question: line(1000) }).strict();
// TASK-072. A tool call names a pinned server and tool; arguments travel as a JSON string because free-form objects are
// not reliable across provider adapters. Nothing here can supply a URL, a header or a session id.
const toolArgs = z.string().min(2).max(6000).refine((value) => {
  try {
    const parsed = JSON.parse(value);
    const depth = (node: unknown, level = 0): number => {
      if (level > 6) return level;
      if (!node || typeof node !== "object") return level;
      return Math.max(level, ...Object.values(node as Record<string, unknown>).map((child) => depth(child, level + 1)));
    };
    return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed) && depth(parsed) <= 6;
  } catch { return false; }
}, "arguments must be a JSON object of depth 6 or less");
const shellCwd = z.string().min(1).max(255).refine((value) => value.split("/").every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== ".."), "use plain relative folders");
// TASK-073. A shell command runs as the agent inside its own network namespace. Text is never kept in a receipt.
const shell = z.object({
  action: z.literal("shell"),
  command: z.string().min(1).max(4000).refine((value) => !value.includes("\u0000"), "contains a null byte"),
  cwd: shellCwd.optional(),
  timeout: z.number().int().min(1).max(600).optional(),
  expect: expectation,
}).strict();
const toolCall = z.object({
  action: z.literal("tool_call"),
  name: z.string().regex(/^[a-z0-9-]{1,32}\.[A-Za-z0-9_.:-]{1,128}$/, "use server.tool"),
  args: toolArgs,
  expect: expectation.optional(),
}).strict();
// TASK-054 / TASK-086. Add, replace or forget one memory entry. `quote` is the owner's exact words; code checks it
// against the owner's stored messages before a change may apply without asking. Text may wrap; title and reason are lines.
const rememberFields = z.object({
  action: z.literal("remember"),
  op: z.enum(["add", "replace", "forget"]).default("add"),
  scope: z.enum(["global", "agent", "private"]),
  title: line(80),
  text: z.string().trim().min(1).max(600).refine(noControls, "contains unsupported control characters").optional(),
  reason: line(120),
  quote: z.string().trim().min(12).max(600).refine(noControls, "contains unsupported control characters").optional(),
}).strict();
const remember = rememberFields.refine((value) => value.op === "forget" || Boolean(value.text), "add and replace need the fact text");
// The agent may acquire its own graphical desktop or browser. Identity, executable and paths are server-bound;
// the model only names the lifecycle step it needs.
const startDesktop = z.object({ action: z.literal("start_desktop"), expect: expectation.optional() }).strict();
const startBrowser = z.object({ action: z.literal("start_browser"), expect: expectation.optional() }).strict();
// TASK-079. Listen to this agent's own speaker for 1-30 seconds; the transcript is untrusted data.
const hearAudio = z.object({
  action: z.literal("hear_audio"),
  seconds: z.number().int().min(1).max(30).optional(),
  expect: expectation,
}).strict();
// TASK-085. Pass the owner's request to one teammate by its exact name. The note is one line of data.
const handoff = z.object({
  action: z.literal("handoff"),
  agent: line(80),
  note: z.string().trim().min(1).max(1000).refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value), "must be a single line without control characters"),
}).strict();
// TASK-076. Start one screenless helper with a subset of this agent's screenless tools.
const toolSlug = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, "use a tool slug");
const spawnSubagent = z.object({
  action: z.literal("spawn_subagent"),
  task: line(1000),
  tools: z.array(toolSlug).min(1).max(10).transform((values) => [...new Set(values)]),
}).strict();

export const intentSchema = z.discriminatedUnion("action", [click, type, key, scroll, wait, getTime, readDocument, searchDocument, searchHistory, deliverFile,
  extract, navigate, select, remember, toolCall, shell, startDesktop, startBrowser, hearAudio, handoff, spawnSubagent, finish, askOwner]);
export type Intent = z.infer<typeof intentSchema>;
export type ClickIntent = Extract<Intent, { action: "click" }>;

// Actions that act on the desktop (and the file actions) need an entry in the agent's `actions`. The lists live in
// lib/agents/actions.ts so the agent form can show the same names.
export { DESKTOP_ACTIONS, LIFECYCLE_ACTIONS, FILE_ACTIONS, MEMORY_ACTIONS, TOOL_ACTIONS, SHELL_ACTIONS, AUDIO_ACTIONS } from "../agents/actions";

export const NEXT_STEP_TOOL_NAME = "next_step";
export const NEXT_STEP_ACTIONS = ["click", "type", "key", "scroll", "wait", "get_time", "read_document", "search_document", "search_history", "deliver_file", "extract", "navigate", "select", "remember", "tool_call", "shell", "start_desktop", "start_browser", "hear_audio", "handoff", "spawn_subagent", "finish", "ask_owner"] as const;
export const NEXT_STEP_TOOL: ProviderTool = {
  name: NEXT_STEP_TOOL_NAME,
  description: "Choose the single next step. Describe the target in words; never give coordinates or selectors.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: { type: "string", enum: NEXT_STEP_ACTIONS },
      name: { type: "string", description: "read_document / search_document / deliver_file: the exact file name from the file list. extract: the short lowercase name to save the text under." },
      value: { type: "string", description: "extract: the exact text shown on the page, copied without changes (up to 2000 characters)." },
      url: { type: "string", description: "navigate: an http or https address, no credentials (up to 2048 characters)." },
      option: { type: "string", description: "select: the visible option to choose in the dropdown (exact label or value, up to 200 characters)." },
      offset: { type: "number", description: "read_document: character offset of the window to read; use next_offset from the previous window, or an offset from a search result. Leave out to start at 0." },
      query: { type: "string", description: "search_document: the words to find in the document (up to 200 characters). search_history: the words to find in earlier chats with this agent. Results include the page or sheet and an offset for read_document." },
      from: { type: "string", enum: ["downloads", "work"], description: "deliver_file: the folder the file is in." },
      timezone: { type: "string", description: "get_time: an IANA timezone such as America/New_York. Leave out for the owner's timezone." },
      op: { type: "string", enum: ["add", "replace", "forget"], description: "remember: add a fact, replace an existing entry by its exact title, or forget it." },
      scope: { type: "string", enum: ["global", "agent", "private"], description: "remember: global -> USER.md, agent -> this agent's MEMORY.md, private -> this agent's private notes." },
      title: { type: "string", description: "remember: a short title for the fact (up to 80 characters); replace and forget use the exact existing title." },
      quote: { type: "string", description: "remember: the owner's exact words for this fact, copied from their message (at least 12 characters). It is checked by code." },
      reason: { type: "string", description: "remember: one line explaining why this should be remembered (up to 120 characters)." },
      target: { type: "string", description: "click: the element to click, in words (for example \"Submit button\"). select: the dropdown to choose in." },
      text: { type: "string", description: "type: the literal text to type into the focused field; {{name}} inserts a value saved by extract. remember: the fact to save or the new text of a replaced entry (up to 600 characters)." },
      keys: { type: "string", description: "key: a key or chord such as Enter or Control+L." },
      direction: { type: "string", enum: ["up", "down"], description: "scroll: direction." },
      expect: { type: "string", description: "Expected result. Prefer control_present: Name, control_absent: Name, url_path: /path, or object_visible: concept; otherwise describe a visible postcondition." },
      summary: { type: "string", description: "finish: your answer or what you did (up to 4000 characters, line breaks allowed), only what the screen or a document shows." },
      question: { type: "string", description: "ask_owner: what you need from the owner." },
      args: { type: "string", description: "tool_call: the tool arguments as a JSON object string, for example {\"query\":\"is:open\"}. Use {} for none." },
      command: { type: "string", description: "shell: the command line to run as you, inside your private network namespace (up to 4000 characters). Use git for repositories." },
      cwd: { type: "string", description: "shell: an optional folder relative to your home, for example work or my-repo." },
      timeout: { type: "number", description: "shell: seconds before the command is stopped (1-600, default 60)." },
      seconds: { type: "number", description: "hear_audio: how many seconds of this agent's speaker audio to transcribe (1-30, default 10)." },
      agent: { type: "string", description: "handoff: the exact name of one teammate from the teammates list." },
      note: { type: "string", description: "handoff: one line of context for the teammate (up to 1000 characters). It is data, not an instruction." },
      task: { type: "string", description: "spawn_subagent: the screenless work for one helper (up to 1000 characters, one line)." },
      tools: { type: "array", items: { type: "string" }, description: "spawn_subagent: 1-10 of your screenless tool names the helper may use." },
      // start_desktop and start_browser take only an optional expect; the server binds the agent and the target.
    },
  },
};

// TASK-084. `{{name}}` in one type step inserts a value saved by extract. A value that is missing or came from a
// different run (a branch keeps names only) makes the step invalid, so it is never executed with a blank.
const PLACEHOLDER = /\{\{([a-z][a-z0-9_]{0,31})\}\}/g;
export type PlaceholderValues = ReadonlyMap<string, string | null>;
export function resolvePlaceholders(text: string, values: PlaceholderValues):
  { ok: true; text: string; used: string[] } | { ok: false; missing: string } {
  const used: string[] = [];
  let missing = "";
  const resolved = text.replace(PLACEHOLDER, (match, name: string) => {
    const value = values.get(name);
    if (typeof value !== "string" || value.length === 0) {
      if (!missing) missing = name;
      return match;
    }
    if (!used.includes(name)) used.push(name);
    return value;
  });
  return missing ? { ok: false, missing } : { ok: true, text: resolved, used };
}

// Why a reply was not a usable step. The code (never model text) goes back to the model in previous_steps so the next
// reply can be corrected, and into the operator log.
export type InvalidStepReason = "no_step" | "computer_call" | "wrong_tool" | "too_long" | "not_json" | "schema";
export type ParsedStep = { ok: true; intent: Intent } | { ok: false; reason: InvalidStepReason; field?: string };

// The fields each action may carry, from the strict schemas above.
const ACTION_FIELDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  [click, type, key, scroll, wait, getTime, readDocument, searchDocument, searchHistory, deliverFile, extract, navigate, select,
    rememberFields, toolCall, shell, startDesktop, startBrowser, hearAudio, handoff, spawnSubagent, finish, askOwner]
    .map((schema): [string, ReadonlySet<string>] => [schema.shape.action.value, new Set(Object.keys(schema.shape))]));
const STEP_FIELDS: ReadonlySet<string> = new Set(Object.keys((NEXT_STEP_TOOL.parameters as { properties: object }).properties));
const NUMBER_FIELDS = new Set(["offset", "timeout", "seconds"]);
// Outer bound on the raw JSON only; each action's schema enforces its real limits. It fits the longest valid step:
// 6000 characters of tool_call args plus a 300-character expect, each character at most 6 when written as \uXXXX.
const MAX_ARGUMENTS = 40_000;

// Models that fill every declared property send unused ones as "", null or [] and sometimes another action's field.
// Those are dropped, a numeric string becomes a number and tool_call args given as an object become a JSON string.
// Only fields declared on the next_step tool are ever dropped: anything else (x, y, coordinate, selector...) is kept
// so the strict schema still rejects the whole step (ADR-008).
function normalizeStep(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  let value = raw as Record<string, unknown>;
  // { "name": "next_step", "arguments": {...} } or { "parameters": {...} } written by models that echo the call.
  if (!("action" in value)) {
    const inner = value.arguments ?? value.parameters ?? value.input;
    if (typeof inner === "string") { try { return normalizeStep(JSON.parse(inner)); } catch { return raw; } }
    if (inner && typeof inner === "object") return normalizeStep(inner);
    return raw;
  }
  const fields = typeof value.action === "string" ? ACTION_FIELDS.get(value.action) : undefined;
  value = { ...value };
  for (const [key, item] of Object.entries(value)) {
    if (key === "action") continue;
    const empty = item === null || item === undefined || (typeof item === "string" && item.trim() === "") || (Array.isArray(item) && item.length === 0);
    if ((empty || (fields && !fields.has(key))) && STEP_FIELDS.has(key)) { delete value[key]; continue; }
    if (NUMBER_FIELDS.has(key) && typeof item === "string" && /^\d{1,9}$/.test(item.trim())) value[key] = Number(item.trim());
    if (key === "args" && item && typeof item === "object" && !Array.isArray(item)) value[key] = JSON.stringify(item);
  }
  return value;
}

function parseArguments(text: string): ParsedStep {
  if (text.length > MAX_ARGUMENTS) return { ok: false, reason: "too_long" };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, reason: "not_json" }; }
  const parsed = intentSchema.safeParse(normalizeStep(raw));
  if (parsed.success) return { ok: true, intent: parsed.data };
  const path = parsed.error.issues[0]?.path.map(String).join(".");
  const unknown = parsed.error.issues.find((issue) => issue.code === "unrecognized_keys") as { keys?: string[] } | undefined;
  const field = (unknown?.keys?.[0] ?? path ?? "").replace(/[^A-Za-z0-9_.]/g, "").slice(0, 40);
  return { ok: false, reason: "schema", ...(field ? { field } : {}) };
}

// A step written as JSON in the reply text (a fenced block or a bare object) instead of a tool call.
function stepFromText(text: string): string | null {
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/i.exec(text);
  const candidate = fenced?.[1] ?? (() => {
    const start = text.indexOf("{"); const end = text.lastIndexOf("}");
    return start >= 0 && end > start ? text.slice(start, end + 1) : null;
  })();
  return candidate && /"action"\s*:/.test(candidate) ? candidate : null;
}

const isNextStep = (name: string) => /^(?:functions\.)?next_step$/.test(name.trim());

// Accepts the first `next_step` function call (a model that emits several runs only the first; each step is checked on
// its own). A reply without a call may carry the step as JSON in its text. Everything still passes the strict schema;
// anything else is invalid and never executed.
export function parseNextStep(outputs: ProviderOutput[]): ParsedStep {
  if (outputs.some((output) => output.type === "computer_call")) return { ok: false, reason: "computer_call" };
  const calls = outputs.filter((output) => output.type === "function_call");
  if (calls.length) {
    const call = calls.find((item) => isNextStep(item.name));
    if (!call) return { ok: false, reason: "wrong_tool" };
    return parseArguments(call.arguments);
  }
  for (const output of outputs) {
    if (output.type !== "message") continue;
    const json = stepFromText(output.text);
    if (json) return parseArguments(json);
  }
  return { ok: false, reason: "no_step" };
}
