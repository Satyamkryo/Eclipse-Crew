import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireDesktopControlSecret } from "../config/server";
import { teachResult, type TeachResult } from "../teach/schema";

const uuid = z.string().uuid();
const FETCH_TIMEOUT_MS = 5000;
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
const sessionResult = z.object({ agentId: uuid, state: z.enum(["starting", "running", "stopped", "stopping", "failed"]),
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
  x: z.number().int().min(0).max(1023), y: z.number().int().min(0).max(767), width: z.number().int().min(1).max(1024), height: z.number().int().min(1).max(768) }).strict()
  .refine((value) => value.x + value.width <= 1024 && value.y + value.height <= 768);
export const pageSnapshotResult = z.object({ pageId: uuid, href: z.string().max(2048), title: z.string().max(1024), frames: z.number().int().min(0).max(64),
  elements: z.array(snapshotElementSchema).max(150), source_tag: z.literal("tool"), untrusted: z.literal(true) }).strict();
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
const commandParams: Record<string, z.ZodType> = {
  "capture.screenshot": z.object({ crop: z.object({ x: z.number().int().min(0).max(1023), y: z.number().int().min(0).max(767), width: z.number().int().min(1).max(1024), height: z.number().int().min(1).max(768) }).strict().refine((value) => value.x + value.width <= 1024 && value.y + value.height <= 768).optional() }).strict(),
  "input.click": z.object({ button: z.enum(["left", "right", "double"]), x: z.number().int().min(0).max(1023), y: z.number().int().min(0).max(767) }).strict(),
  "input.type": z.object({ text: textSchema }).strict(),
  "input.key": z.object({ key: keySchema }).strict(),
  "input.scroll": z.object({ direction: z.enum(["up", "down", "left", "right"]), count: z.number().int().min(1).max(20) }).strict(),
  "browser.pages": z.object({}).strict(),
  "page.snapshot": z.object({ pageId: uuid.optional() }).strict(),
  "page.verify": z.object({ predicate: verificationPredicate }).strict(),
  "file.open": z.object({ name: z.string().min(1).max(255).refine((value) => !/[\u0000-\u001f\u007f-\u009f/\\]/.test(value) && !value.startsWith(".")) }).strict(),
  "browser.locator": z.object({ selector: z.string().min(1).max(512).refine((value) => !/[\x00-\x1f\x7f]/.test(value)), pageId: uuid.optional(), action: z.enum(["inspect", "click", "fill"]), text: textSchema.optional() }).strict().refine((v) => v.action !== "fill" || v.text !== undefined),
};
export async function desktopCommand(agentId: string, ownerId: string, generation: string, operation: string, params: Record<string, unknown>): Promise<unknown> {
  if (!Object.hasOwn(commandParams, operation)) throw new Error("invalid_operation");
  const args = commandParams[operation].parse(params) as Record<string, unknown>;
  const result: z.ZodType<unknown> = operation === "capture.screenshot" ? screenshotResult : operation === "browser.pages" ? pagesResult : operation === "page.snapshot" ? pageSnapshotResult : operation === "page.verify" ? pageVerificationResult : operation === "browser.locator" && args.action === "inspect" ? locatorResult : inputResult;
  return desktopPost(`/v1/agents/${uuid.parse(agentId)}/commands`, { ...args, ...metadata(agentId, ownerId), ...z.object(generationField).parse({ generation }), operation }, result);
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
export async function desktopSession(agentId: string, ownerId: string, operation: "session.start" | "session.status" | "session.stop") {
  z.enum(["session.start", "session.status", "session.stop"]).parse(operation);
  const result = await desktopPost(`/v1/agents/${uuid.parse(agentId)}/commands`,
    { ...metadata(agentId, ownerId), operation }, sessionResult,
    operation === "session.start" ? LIFECYCLE_TIMEOUT_MS : operation === "session.stop" ? 15000 : FETCH_TIMEOUT_MS);
  if (result.agentId !== agentId) throw new Error("invalid_response_agent");
  return { agentId: result.agentId, state: result.state, ...(result.generation ? { generation: result.generation } : {}),
    ...(result.takenOver === undefined ? {} : { takenOver: result.takenOver }) };
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
export async function desktopDownloadOutbox(agentId: string, ownerId: string, file: { name: string; size: number; sha256: string }, signal?: AbortSignal) {
  const response = await fetch(`${outboxTarget.base}/v1/owners/${uuid.parse(ownerId)}/agents/${uuid.parse(agentId)}/outbox/read`, { method: "POST", redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(UPLOAD_TIMEOUT_MS)]) : AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${requireDesktopSecret()}` },
    body: JSON.stringify({ name: file.name, sha256: file.sha256, size: file.size }) });
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
  kind: z.literal("text"), format: z.enum(["text", "pdf", "docx"]), truncated: z.boolean(),
  text: z.string().min(1).max(60_000), offset: z.number().int().min(0), nextOffset: z.number().int().min(1).nullable(), totalChars: z.number().int().min(1),
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
export type DeliveredFile = z.infer<typeof deliveredFile>;

function fileToolPath(agentId: string, ownerId: string, action: "list" | "read" | "deliver") {
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
