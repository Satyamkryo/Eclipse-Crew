import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireDesktopControlSecret } from "../config/server";
import { teachResult, type TeachResult } from "../teach/schema";

const uuid = z.string().uuid();
const FETCH_TIMEOUT_MS = 5000;
// Reading a heavy page, or checking focus across its frames, takes real time. Above the desktop's own bounds, so it answers first.
const PAGE_READ_TIMEOUT_MS = 16_000;
const FOCUS_INPUT_TIMEOUT_MS = 12_000;
// Above the desktop's own navigation bounds (20 s load, 25 s channel), so the desktop answers first.
const NAVIGATE_TIMEOUT_MS = 28_000;
const verificationPredicate = z.object({ kind: z.enum(["control_present", "control_absent", "url_path"]), value: z.string().min(1).max(200).refine((v) => !/[\x00-\x1f\x7f-\x9f]/.test(v)) }).strict();
export const pageVerificationResult = z.object({ status: z.enum(["pass", "fail", "unknown"]), code: z.enum(["url_path", "unsupported_url", "ambiguous_control", "visible_inventory", "unsupported_expectation"]), source_tag: z.literal("tool"), untrusted: z.literal(true) }).strict();

const LIFECYCLE_TIMEOUT_MS = 45000;
const MAX_RESULT_BYTES = 6 * 1024 * 1024;
const DESKTOP_BASE_URL = "http://desktop:4310";
export function requireDesktopSecret(): string { return requireDesktopControlSecret(process.env.DESKTOP_CONTROL_SECRET); }
export function streamUrl(agentId: string): string { return `/api/desktop/${uuid.parse(agentId)}/stream`; }
const leaseFields = { generation: uuid, connectionId: uuid };
const keyNames = ["Enter", "Tab", "Escape", "Space", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)];
const keySchema = z.string().min(1).max(64).refine((value) => {
  const parts = value.split("+");
  const key = parts.pop()!;
  return new Set(parts).size === parts.length && parts.every((part) => ["Control", "Alt", "Shift", "Meta"].includes(part)) &&
    (keyNames.includes(key) || parts.length > 0 && /^[a-z0-9]$/i.test(key));
});
const textSchema = z.string().max(4096).refine((value) => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value));
export const takeoverBodySchema = z.object(leaseFields).strict();
export const handbackBodySchema = z.object({ ...leaseFields, leaseId: uuid }).strict();
const inputFields = { ...leaseFields, leaseId: uuid };
export const ownerInputBodySchema = z.discriminatedUnion("operation", [
  z.object({ ...inputFields, operation: z.literal("input.click"), button: z.enum(["left", "right", "double"]),
    x: z.number().int().min(0).max(1023), y: z.number().int().min(0).max(767) }).strict(),
  z.object({ ...inputFields, operation: z.literal("input.type"), text: textSchema }).strict(),
  z.object({ ...inputFields, operation: z.literal("input.key"), key: keySchema }).strict(),
  z.object({ ...inputFields, operation: z.literal("input.scroll"), direction: z.enum(["up", "down", "left", "right"]),
    count: z.number().int().min(1).max(20) }).strict(),
  z.object({ ...inputFields, operation: z.literal("input.drag"), x: z.number().int().min(0).max(1023), y: z.number().int().min(0).max(767),
    toX: z.number().int().min(0).max(1023), toY: z.number().int().min(0).max(767) }).strict(),
]);
const controlFields = { ownerId: uuid, agentId: uuid, requestId: uuid };
export const LIFECYCLE_STATES = ["stopped", "starting", "running", "failed"] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];
const sessionResult = z.object({ agentId: uuid, state: z.enum(["starting", "running", "stopped", "stopping", "failed"]),
  sandbox: z.enum(LIFECYCLE_STATES).optional(), graphics: z.enum(LIFECYCLE_STATES).optional(), browser: z.enum(LIFECYCLE_STATES).optional(),
  generation: uuid.optional(), display: z.number().int().optional(), reason: z.string().max(128).optional(),
  vncPort: z.number().int().min(1).max(65535).optional(), vncReady: z.boolean().optional(), takenOver: z.boolean().optional() }).strict();
const inputResult = z.object({ ok: z.literal(true) }).strict();
const screenshotResult = z.object({ width: z.number().int().min(1).max(1024), height: z.number().int().min(1).max(768),
  base64: z.string().max(5592408).regex(/^[A-Za-z0-9+/]+={0,2}$/), source_tag: z.literal("tool"), untrusted: z.literal(true) }).strict();
const pagesResult = z.object({ pages: z.array(z.object({ pageId: uuid, href: z.string().max(2048), title: z.string().max(1024) }).strict()).max(32), source_tag: z.literal("tool"), untrusted: z.literal(true) }).strict();
const locatorResult = z.object({ tag: z.string().max(64), text: z.string().max(4096), boundingBox: z.object({
  x: z.number().finite(), y: z.number().finite(), width: z.number().nonnegative().finite(), height: z.number().nonnegative().finite() }).strict().nullable(),
  ok: z.boolean().optional(), source_tag: z.literal("tool"), untrusted: z.literal(true) }).strict();
// Names come from an untrusted page: bounded and free of control characters. Positions are screen pixels (1024x768).
const snapshotElementSchema = z.object({ ref: z.number().int().min(1).max(150), role: z.string().regex(/^[a-z]{1,32}$/),
  name: z.string().max(80).refine((value) => !/[\x00-\x1f\x7f-\x9f]/.test(value)), tag: z.string().regex(/^[a-z0-9-]{1,32}$/), focused: z.boolean().optional(),
  frame: z.enum(["top", "child"]), shadow: z.boolean(),
  x: z.number().int().min(0).max(1023), y: z.number().int().min(0).max(767), width: z.number().int().min(1).max(1024), height: z.number().int().min(1).max(768) }).strict()
  .refine((value) => value.x + value.width <= 1024 && value.y + value.height <= 768);
export const pageSnapshotResult = z.object({ pageId: uuid, href: z.string().max(2048), title: z.string().max(1024), frames: z.number().int().min(0).max(64),
  paymentFrames: z.number().int().min(0).max(64),
  elements: z.array(snapshotElementSchema).max(150), source_tag: z.literal("tool"), untrusted: z.literal(true) }).strict();
const findTextResult = z.object({ found: z.boolean(), count: z.number().int().min(0).max(1000),
  source_tag: z.literal("tool"), untrusted: z.literal(true) }).strict();
const waveResult = z.object({ base64: z.string().min(4).max(2_900_000).regex(/^[A-Za-z0-9+/]+={0,2}$/), mime: z.literal("audio/wav"),
  durationMs: z.number().int().min(1).max(30_500), source_tag: z.literal("tool"), untrusted: z.literal(true) }).strict();
export type FindTextResult = z.infer<typeof findTextResult>;
const envelopeSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ok"), result: z.unknown() }).strict(),
  z.object({ outcome: z.literal("error"), code: z.string().regex(/^[a-z_]{1,64}$/) }).strict(),
]);
async function desktopPost<T>(path: string, body: unknown, resultSchema: z.ZodType<T>, timeoutMs = FETCH_TIMEOUT_MS,
  target: { base: string; maxBody: number } = { base: DESKTOP_BASE_URL, maxBody: 16 * 1024 }): Promise<T> {
  const text = JSON.stringify(body);
  if (Buffer.byteLength(text) > target.maxBody) throw new Error("request_body_too_large");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("desktop_timeout")); }, timeoutMs);
  });
  try {
    const response = await Promise.race([fetch(`${target.base}${path}`, { method: "POST", redirect: "error", signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${requireDesktopSecret()}` }, body: text }), deadline]);
    const declared = response.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESULT_BYTES)) throw new Error("response_body_too_large");
    if (!response.body) throw new Error("invalid_response_body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await Promise.race([reader.read(), deadline]);
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESULT_BYTES) throw new Error("response_body_too_large");
        chunks.push(value);
      }
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    const parsed = envelopeSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!parsed.success) throw new Error("invalid_response_shape");
    if (parsed.data.outcome === "error") throw Object.assign(new Error(parsed.data.code), { code: parsed.data.code });
    if (!response.ok) throw new Error("invalid_response_status");
    return resultSchema.parse(parsed.data.result);
  } finally { clearTimeout(timer); }
}
function metadata(agentId: string, ownerId: string) { return z.object(controlFields).parse({ agentId, ownerId, requestId: randomUUID() }); }
function sessionReference(value: string) { return z.string().regex(/^[0-9a-f]{64}$/).parse(value); }
export async function desktopTakeOver(agentId: string, ownerId: string, sessionRef: string, body: z.infer<typeof takeoverBodySchema>) {
  return desktopPost(`/v1/agents/${uuid.parse(agentId)}/takeover`, { ...takeoverBodySchema.parse(body), ...metadata(agentId, ownerId), sessionRef: sessionReference(sessionRef) },
    z.object({ takenOver: z.literal(true), leaseId: uuid, generation: uuid }).strict());
}
export async function desktopHandBack(agentId: string, ownerId: string, sessionRef: string, body: z.infer<typeof handbackBodySchema>) {
  return desktopPost(`/v1/agents/${uuid.parse(agentId)}/handback`, { ...handbackBodySchema.parse(body), ...metadata(agentId, ownerId), sessionRef: sessionReference(sessionRef) },
    z.object({ takenOver: z.literal(false), generation: uuid, agentId: uuid.optional() }).strict());
}
export async function desktopOwnerInput(agentId: string, ownerId: string, sessionRef: string, body: z.infer<typeof ownerInputBodySchema>) {
  return desktopPost(`/v1/agents/${uuid.parse(agentId)}/input`, { ...ownerInputBodySchema.parse(body), ...metadata(agentId, ownerId), sessionRef: sessionReference(sessionRef) }, inputResult);
}
export async function desktopTeach(agentId: string, ownerId: string, sessionRef: string, body: Record<string, unknown>): Promise<TeachResult> {
  return desktopPost(`/v1/agents/${uuid.parse(agentId)}/teach`, { ...body, ...metadata(agentId, ownerId), sessionRef: sessionReference(sessionRef) }, teachResult, LIFECYCLE_TIMEOUT_MS);
}
const generationField = { generation: uuid };
const windowResult = z.object({ kind: z.enum(["browser", "terminal", "file_manager", "other", "none"]), source_tag: z.literal("tool"), untrusted: z.literal(true) }).strict();
const commandParams: Record<string, z.ZodType> = {
  "capture.screenshot": z.object({ crop: z.object({ x: z.number().int().min(0).max(1023), y: z.number().int().min(0).max(767), width: z.number().int().min(1).max(1024), height: z.number().int().min(1).max(768) }).strict().refine((value) => value.x + value.width <= 1024 && value.y + value.height <= 768).optional() }).strict(),
  "input.click": z.object({ button: z.enum(["left", "right", "double"]), x: z.number().int().min(0).max(1023), y: z.number().int().min(0).max(767) }).strict(),
  "input.type": z.object({ text: textSchema }).strict(),
  "input.key": z.object({ key: keySchema }).strict(),
  "input.scroll": z.object({ direction: z.enum(["up", "down", "left", "right"]), count: z.number().int().min(1).max(20) }).strict(),
  // ADR-041. Agent-only: these are not in the owner takeover input schema.
  "input.screen_click": z.object({ x: z.number().int().min(0).max(1023), y: z.number().int().min(0).max(767), button: z.enum(["left", "right", "double"]) }).strict(),
  "input.screen_drag": z.object({ x: z.number().int().min(0).max(1023), y: z.number().int().min(0).max(767), toX: z.number().int().min(0).max(1023), toY: z.number().int().min(0).max(767) }).strict(),
  "input.screen_scroll": z.object({ x: z.number().int().min(0).max(1023), y: z.number().int().min(0).max(767), direction: z.enum(["up", "down", "left", "right"]), count: z.number().int().min(1).max(20) }).strict(),
  "input.screen_type": z.object({ text: textSchema, terminal: z.boolean() }).strict(),
  "input.screen_key": z.object({ key: keySchema, terminal: z.boolean() }).strict(),
  "window.active": z.object({}).strict(),
  "browser.pages": z.object({}).strict(),
  "page.snapshot": z.object({ pageId: uuid.optional() }).strict(),
  "page.verify": z.object({ predicate: verificationPredicate }).strict(),
  // TASK-084. Page text is copied exactly; it may contain line breaks, but never other control characters.
  "page.find_text": z.object({ text: z.string().min(1).max(2000).refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)), pageId: uuid.optional() }).strict(),
  "browser.navigate": z.object({ url: z.string().min(1).max(2048).refine((value) => {
    try { const url = new URL(value); return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password; } catch { return false; }
  }) }).strict(),
  "input.select": z.object({ x: z.number().int().min(0).max(1023), y: z.number().int().min(0).max(767),
    option: z.string().min(1).max(200).refine((value) => !/[\u0000-\u001f\u007f-\u009f]/.test(value)) }).strict(),
  "file.open": z.object({ name: z.string().min(1).max(255).refine((value) => !/[\u0000-\u001f\u007f-\u009f/\\]/.test(value) && !value.startsWith(".")) }).strict(),
  "browser.locator": z.object({ selector: z.string().min(1).max(512).refine((value) => !/[\x00-\x1f\x7f]/.test(value)), pageId: uuid.optional(), action: z.enum(["inspect", "click", "fill"]), text: textSchema.optional() }).strict().refine((v) => v.action !== "fill" || v.text !== undefined),
  // TASK-079. The agent's private speaker, bounded to 30 seconds.
  "audio.capture": z.object({ seconds: z.number().int().min(1).max(30) }).strict(),
  // TASK-073. Runs as the agent inside its namespace. The shell port validates the result.
  "shell.run": z.object({ command: z.string().min(1).max(4000).refine((value) => !value.includes("\0")),
    cwd: z.string().min(1).max(255).optional(), timeout: z.number().int().min(1).max(600).optional() }).strict(),
};
export async function desktopCommand(agentId: string, ownerId: string, generation: string, operation: string, params: Record<string, unknown>): Promise<unknown> {
  if (!Object.hasOwn(commandParams, operation)) throw new Error("invalid_operation");
  const args = commandParams[operation].parse(params) as Record<string, unknown>;
  const result: z.ZodType<unknown> = operation === "capture.screenshot" ? screenshotResult : operation === "browser.pages" ? pagesResult
    : operation === "page.snapshot" ? pageSnapshotResult : operation === "page.verify" ? pageVerificationResult
    : operation === "page.find_text" ? findTextResult : operation === "audio.capture" ? waveResult : operation === "window.active" ? windowResult
    : operation === "browser.locator" && args.action === "inspect" ? locatorResult : operation === "shell.run" ? z.unknown() : inputResult;
  return desktopPost(`/v1/agents/${uuid.parse(agentId)}/commands`, { ...args, ...metadata(agentId, ownerId), ...z.object(generationField).parse({ generation }), operation }, result,
    operation === "audio.capture" ? (Number(args.seconds) + 10) * 1000 : operation === "browser.navigate" ? NAVIGATE_TIMEOUT_MS
      : operation === "shell.run" ? (Number(args.timeout ?? 60) + 12) * 1000
      : operation === "page.snapshot" || operation === "page.verify" || operation === "page.find_text" ? PAGE_READ_TIMEOUT_MS
      : operation === "input.type" || operation === "input.key" || operation === "input.screen_type" || operation === "input.screen_key" ? FOCUS_INPUT_TIMEOUT_MS
      : operation === "input.screen_click" || operation === "input.screen_drag" ? FOCUS_INPUT_TIMEOUT_MS : FETCH_TIMEOUT_MS);
}
export async function desktopCreateAgent(agentId: string, ownerId: string) {
  const result = await desktopPost(`/v1/agents/${uuid.parse(agentId)}/commands`,
    { ...metadata(agentId, ownerId), operation: "agent.create" },
    z.object({ agentId: uuid, state: z.literal("ready") }).strict(), LIFECYCLE_TIMEOUT_MS);
  if (result.agentId !== agentId) throw new Error("invalid_response_agent");
  return { agentId: result.agentId };
}
export async function desktopDeleteAgent(agentId: string, ownerId: string) {
  const result = await desktopPost(`/v1/agents/${uuid.parse(agentId)}/commands`,
    { ...metadata(agentId, ownerId), operation: "agent.delete" },
    z.object({ agentId: uuid }).strict(), LIFECYCLE_TIMEOUT_MS);
  if (result.agentId !== agentId) throw new Error("invalid_response_agent");
  return { agentId: result.agentId };
}
export type SessionOperation = "session.start" | "session.status" | "session.stop" | "sandbox.start" | "desktop.start" | "desktop.stop" | "browser.start" | "browser.stop";
export interface DesktopStatus {
  agentId: string; state: string; sandbox: LifecycleState; graphics: LifecycleState; browser: LifecycleState;
  generation?: string; display?: number; reason?: string; takenOver?: boolean; vncPort?: number; vncReady?: boolean;
}
export async function desktopSession(agentId: string, ownerId: string, operation: SessionOperation, generation?: string) {
  z.enum(["session.start", "session.status", "session.stop", "sandbox.start", "desktop.start", "desktop.stop", "browser.start", "browser.stop"]).parse(operation);
  const result = await desktopPost(`/v1/agents/${uuid.parse(agentId)}/commands`,
    { ...metadata(agentId, ownerId), operation, ...(generation ? { generation: uuid.parse(generation) } : {}) }, sessionResult,
    operation === "session.status" ? FETCH_TIMEOUT_MS : LIFECYCLE_TIMEOUT_MS);
  if (result.agentId !== agentId) throw new Error("invalid_response_agent");
  return {
    agentId: result.agentId, state: result.state, sandbox: result.sandbox ?? "stopped", graphics: result.graphics ?? "stopped", browser: result.browser ?? "stopped",
    ...(result.generation ? { generation: result.generation } : {}), ...(result.display === undefined ? {} : { display: result.display }),
    ...(result.reason ? { reason: result.reason } : {}), ...(result.takenOver === undefined ? {} : { takenOver: result.takenOver }),
    ...(result.vncPort === undefined ? {} : { vncPort: result.vncPort }), ...(result.vncReady === undefined ? {} : { vncReady: result.vncReady }),
  } satisfies DesktopStatus;
}

const UPLOAD_BASE_URL = "http://desktop:4311";
const UPLOAD_TIMEOUT_MS = 16 * 60 * 1000;
const uploadResult = z.object({ storedName: z.string().min(1).max(255), size: z.number().int().min(1), kind: z.enum(["image", "pdf", "document", "text", "audio", "video", "archive"]),
  sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
// Streams the body to the desktop upload listener. The app never stores the bytes and never sees the workspace volume.
export async function desktopUploadInbox(agentId: string, ownerId: string, body: ReadableStream<Uint8Array>,
  input: { name: string; size: number; limit: number }) {
  const url = `${UPLOAD_BASE_URL}/v1/owners/${uuid.parse(ownerId)}/agents/${uuid.parse(agentId)}/inbox`;
  const init: RequestInit & { duplex: "half" } = { method: "POST", redirect: "error", body, duplex: "half", signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    headers: { "Content-Type": "application/octet-stream", "Content-Length": String(input.size), "X-File-Name": encodeURIComponent(input.name),
      "X-Max-Bytes": String(input.limit), Authorization: `Bearer ${requireDesktopSecret()}` } };
  const response = await fetch(url, init);
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 8192)) throw new Error("response_body_too_large");
  const text = (await response.text()).slice(0, 8192);
  const parsed = envelopeSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error("invalid_response_shape");
  if (parsed.data.outcome === "error") throw Object.assign(new Error(parsed.data.code), { code: parsed.data.code });
  if (!response.ok) throw new Error("invalid_response_status");
  return uploadResult.parse(parsed.data.result);
}

const outboxTarget = { base: "http://desktop:4311", maxBody: 256 * 1024 };
const outboxFile = z.object({ name: z.string().min(1).max(255), size: z.number().int().min(1), kind: z.enum(["image", "pdf", "document", "text", "audio", "video", "archive"]),
  sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
// Files the agent wrote to outbox/ that have no card yet (the desktop hashes at most five per call).
export async function desktopListOutbox(agentId: string, ownerId: string, known: [string, number][]) {
  return desktopPost(`/v1/owners/${uuid.parse(ownerId)}/agents/${uuid.parse(agentId)}/outbox/list`, { known },
    z.object({ files: z.array(outboxFile).max(5), pending: z.number().int().min(0) }).strict(), 60_000, outboxTarget);
}
// Streams one outbox file. The desktop re-checks the SHA-256 and size against the card before sending any byte.
export async function desktopDownloadOutbox(agentId: string, ownerId: string, file: { name: string; size: number; sha256: string }, signal?: AbortSignal,
  area: "inbox" | "outbox" = "outbox") {
  const response = await fetch(`${outboxTarget.base}/v1/owners/${uuid.parse(ownerId)}/agents/${uuid.parse(agentId)}/outbox/read`, { method: "POST", redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(UPLOAD_TIMEOUT_MS)]) : AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${requireDesktopSecret()}` },
    body: JSON.stringify({ name: file.name, sha256: file.sha256, size: file.size, ...(area === "inbox" ? { area } : {}) }) });
  if (response.headers.get("content-type")?.startsWith("application/json") || !response.ok || !response.body) {
    let code = "download_failed";
    try { const parsed = envelopeSchema.safeParse(JSON.parse((await response.text()).slice(0, 8192))); if (parsed.success && parsed.data.outcome === "error") code = parsed.data.code; } catch { /* keep default */ }
    throw Object.assign(new Error(code), { code });
  }
  if (response.headers.get("content-length") !== String(file.size)) { void response.body.cancel().catch(() => {}); throw Object.assign(new Error("file_changed"), { code: "file_changed" }); }
  return response.body;
}

// ---- Agent file tools (TASK-067). The desktop runs them as the agent's own Linux user; results are untrusted data. ----
const fileToolTarget = { base: "http://desktop:4311", maxBody: 4 * 1024 };
const fileToolName = z.string().min(1).max(255).refine((value) => !/[\u0000-\u001f\u007f-\u009f/\\]/.test(value) && !value.startsWith("."));
const listedFile = z.object({
  area: z.enum(["inbox", "downloads", "work"]), name: fileToolName, size: z.number().int().min(1),
  kind: z.enum(["image", "pdf", "document", "text", "audio", "video", "archive", "blocked", "unknown"]),
}).strict();
const textWindow = z.object({
  kind: z.literal("text"), format: z.enum(["text", "pdf", "docx", "xlsx", "pptx"]), truncated: z.boolean(),
  text: z.string().min(1).max(20_000), offset: z.number().int().min(0), nextOffset: z.number().int().min(1).nullable(), totalChars: z.number().int().min(1),
}).strict();
// TASK-082. Best-matching passages with the page, sheet or slide at each start. Passage text is untrusted document data.
const documentSearch = z.object({
  format: z.enum(["text", "pdf", "docx", "xlsx", "pptx"]),
  totalChars: z.number().int().min(1),
  results: z.array(z.object({
    offset: z.number().int().min(0), page: z.number().int().min(1).nullable(),
    text: z.string().min(1).max(1_500), score: z.number().finite(),
  }).strict()).max(5),
}).strict();
const imageDocument = z.object({
  kind: z.literal("image"), mime: z.enum(["image/png", "image/jpeg", "image/webp"]), size: z.number().int().min(1).max(4 * 1024 * 1024),
  base64: z.string().min(4).max(5_800_000),
}).strict();
const deliveredFile = z.object({
  name: fileToolName, size: z.number().int().min(1), kind: z.enum(["image", "pdf", "document", "text", "audio", "video", "archive"]),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type ListedFile = z.infer<typeof listedFile>;
export type DocumentWindow = z.infer<typeof textWindow> | z.infer<typeof imageDocument>;
export type DocumentSearchResult = z.infer<typeof documentSearch>;
export type DeliveredFile = z.infer<typeof deliveredFile>;

function fileToolPath(agentId: string, ownerId: string, action: "list" | "read" | "deliver" | "search") {
  return `/v1/owners/${uuid.parse(ownerId)}/agents/${uuid.parse(agentId)}/files/${action}`;
}
export async function desktopListFiles(agentId: string, ownerId: string) {
  return desktopPost(fileToolPath(agentId, ownerId, "list"), {}, z.object({ files: z.array(listedFile).max(50) }).strict(), 30_000, fileToolTarget);
}
export async function desktopReadFile(agentId: string, ownerId: string, name: string, offset = 0) {
  return desktopPost(fileToolPath(agentId, ownerId, "read"), { name: fileToolName.parse(name), offset: z.number().int().min(0).max(5_000_000).parse(offset) },
    z.discriminatedUnion("kind", [textWindow, imageDocument]), 70_000, fileToolTarget);
}
export async function desktopDeliverFile(agentId: string, ownerId: string, from: "downloads" | "work", name: string) {
  return desktopPost(fileToolPath(agentId, ownerId, "deliver"), { from: z.enum(["downloads", "work"]).parse(from), name: fileToolName.parse(name) },
    deliveredFile, 120_000, fileToolTarget);
}
// Indexing and search get their own budget on the desktop (180 s); the app waits a little longer than that.
const searchQuery = z.string().min(1).max(200).refine((value) => !/[\u0000-\u001f\u007f-\u009f]/.test(value));
export async function desktopSearchFile(agentId: string, ownerId: string, name: string, query: string) {
  return desktopPost(fileToolPath(agentId, ownerId, "search"), { name: fileToolName.parse(name), query: searchQuery.parse(query) },
    documentSearch, 190_000, fileToolTarget);
}

// ---- Per-step checkpoints (TASK-032). The desktop lists the agent's files with their hashes and returns file bytes; the app
// stores them by hash. Results are untrusted data: names are validated here, and the app re-hashes every body it receives. ----
export const checkpointArea = z.enum(["inbox", "work", "downloads", "outbox"]);
const checkpointPath = z.string().min(1).max(1024).refine((value) => !/[\u0000-\u001f\u007f-\u009f\\]/.test(value) && !value.startsWith("/") &&
  !value.split("/").some((part) => part === "" || part === "." || part === ".."));
export const checkpointEntry = z.object({
  area: checkpointArea, path: checkpointPath, size: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(), restorable: z.boolean(),
}).strict().refine((entry) => entry.restorable === (entry.sha256 !== null));
export type CheckpointEntry = z.infer<typeof checkpointEntry>;
export async function desktopCheckpointManifest(agentId: string, ownerId: string) {
  return desktopPost(`/v1/owners/${uuid.parse(ownerId)}/agents/${uuid.parse(agentId)}/checkpoint/manifest`, {},
    z.object({ entries: z.array(checkpointEntry).max(2000), skipped: z.number().int().min(0) }).strict(), 30_000, fileToolTarget);
}
export async function desktopCheckpointBlob(agentId: string, ownerId: string, file: { area: z.infer<typeof checkpointArea>; path: string; sha256: string }) {
  const body = { area: checkpointArea.parse(file.area), path: checkpointPath.parse(file.path), sha256: z.string().regex(/^[0-9a-f]{64}$/).parse(file.sha256) };
  const result = await desktopPost(`/v1/owners/${uuid.parse(ownerId)}/agents/${uuid.parse(agentId)}/checkpoint/blob`, body,
    z.object({ size: z.number().int().min(0).max(4 * 1024 * 1024), base64: z.string().max(5_800_000) }).strict(), 30_000, fileToolTarget);
  const bytes = Buffer.from(result.base64, "base64");
  if (bytes.length !== result.size) throw Object.assign(new Error("content_changed"), { code: "content_changed" });
  return bytes;
}

// ---- Rewind restore (TASK-043). One saved file is streamed back to the agent's own user; the desktop re-hashes it before
// the rename. Only the fixed codes from the tool reach the app. ----
const CHECKPOINT_PUT_TIMEOUT_MS = 60_000;
const checkpointPutResult = z.object({ size: z.number().int().min(0).max(4 * 1024 * 1024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export async function desktopCheckpointPut(agentId: string, ownerId: string,
  file: { area: z.infer<typeof checkpointArea>; path: string; sha256: string; size: number }, bytes: Uint8Array) {
  const path = checkpointPath.parse(file.path);
  const sha256 = z.string().regex(/^[0-9a-f]{64}$/).parse(file.sha256);
  if (bytes.length !== file.size || file.size > 4 * 1024 * 1024) throw Object.assign(new Error("content_changed"), { code: "content_changed" });
  const url = `${outboxTarget.base}/v1/owners/${uuid.parse(ownerId)}/agents/${uuid.parse(agentId)}/checkpoint/put`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECKPOINT_PUT_TIMEOUT_MS);
  try {
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const response = await fetch(url, { method: "POST", redirect: "error", signal: controller.signal, body,
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length), "X-Area": checkpointArea.parse(file.area),
        "X-Path": encodeURIComponent(path), "X-Sha256": sha256, Authorization: `Bearer ${requireDesktopSecret()}` } });
    const declared = response.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > 8192)) throw new Error("response_body_too_large");
    const text = (await response.text()).slice(0, 8192);
    const parsed = envelopeSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error("invalid_response_shape");
    if (parsed.data.outcome === "error") throw Object.assign(new Error(parsed.data.code), { code: parsed.data.code });
    if (!response.ok) throw new Error("invalid_response_status");
    const result = checkpointPutResult.parse(parsed.data.result);
    if (result.size !== file.size || result.sha256 !== sha256) throw Object.assign(new Error("content_changed"), { code: "content_changed" });
    return result;
  } finally { clearTimeout(timer); }
}
export async function desktopCheckpointAside(agentId: string, ownerId: string,
  file: { area: z.infer<typeof checkpointArea>; path: string; bucket: string }) {
  return desktopPost(`/v1/owners/${uuid.parse(ownerId)}/agents/${uuid.parse(agentId)}/checkpoint/aside`,
    { area: checkpointArea.parse(file.area), path: checkpointPath.parse(file.path), bucket: uuid.parse(file.bucket) },
    z.object({ moved: z.literal(true) }).strict(), CHECKPOINT_PUT_TIMEOUT_MS, fileToolTarget);
}
