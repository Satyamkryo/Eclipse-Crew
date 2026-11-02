import { z } from "zod";
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const uuid = z.string().regex(UUID_PATTERN);
const generation = uuid;
const verificationPredicate = z.object({ kind: z.enum(["control_present", "control_absent", "url_path"]), value: z.string().min(1).max(200).refine((v) => !/[\x00-\x1f\x7f-\x9f]/.test(v)) }).strict();
export const pageVerificationResult = z.object({ status: z.enum(["pass", "fail", "unknown"]), code: z.enum(["url_path", "unsupported_url", "ambiguous_control", "visible_inventory", "unsupported_expectation"]), source_tag: z.literal("tool"), untrusted: z.literal(true) }).strict();

const base = { ownerId: uuid, agentId: uuid, requestId: uuid };
const running = { ...base, generation };
const KEY_NAMES = ["Enter", "Tab", "Escape", "Space", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)];
export const ALLOWED_KEYS = new Set([...KEY_NAMES, "Control+c", "Control+v", "Control+a", "Control+z", "Control+y", "Alt+F4", "Meta+l"]);
export function validKey(value) {
  if (typeof value !== "string" || value.length > 64) return false;
  const parts = value.split("+"); const key = parts.pop();
  if (new Set(parts).size !== parts.length || !parts.every((m) => ["Control", "Alt", "Shift", "Meta"].includes(m))) return false;
  return KEY_NAMES.includes(key) || parts.length > 0 && /^[a-z0-9]$/i.test(key);
}
const text = z.string().max(4096).refine((v) => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v));
const crop = z.object({ x: z.number().int().min(0).max(1023), y: z.number().int().min(0).max(767), width: z.number().int().min(1).max(1024), height: z.number().int().min(1).max(768) }).strict().refine((v) => v.x + v.width <= 1024 && v.y + v.height <= 768);
const input = [
  { operation: z.literal("input.drag"), x: z.number().int().min(0).max(1023), y: z.number().int().min(0).max(767), toX: z.number().int().min(0).max(1023), toY: z.number().int().min(0).max(767) },
  { operation: z.literal("input.click"), button: z.enum(["left", "right", "double"]), x: z.number().int().min(0).max(1023), y: z.number().int().min(0).max(767) },
  { operation: z.literal("input.type"), text },
  { operation: z.literal("input.key"), key: z.string().refine(validKey) },
  { operation: z.literal("input.scroll"), direction: z.enum(["up", "down", "left", "right"]), count: z.number().int().min(1).max(20) },
];
const locator = { operation: z.literal("browser.locator"), selector: z.string().min(1).max(512).refine((v) => !/[\x00-\x1f\x7f]/.test(v)), pageId: uuid.optional(), action: z.enum(["inspect", "click", "fill"]), text: text.optional() };
const fileName = z.string().min(1).max(255).refine((v) => !/[\u0000-\u001f\u007f-\u009f/\\]/.test(v) && !v.startsWith("."));
// TASK-073. A shell command runs as the agent inside its namespace; cwd stays under the home.
const shellCommand = z.string().min(1).max(4000).refine((value) => !value.includes("\0"));
const shellCwd = z.string().min(1).max(255).refine((value) => value.split("/").every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== ".."));
export const OperationSchema = z.discriminatedUnion("operation", [
  ...input.map((v) => z.object(v).strict()),
  z.object({ operation: z.literal("capture.screenshot"), crop: crop.optional() }).strict(),
  z.object({ operation: z.literal("browser.pages") }).strict(),
  z.object({ operation: z.literal("page.snapshot"), pageId: uuid.optional() }).strict(),
  z.object({ operation: z.literal("page.verify"), predicate: verificationPredicate }).strict(),
  z.object({ operation: z.literal("file.open"), name: fileName }).strict(),
  z.object({ operation: z.literal("shell.run"), command: shellCommand, cwd: shellCwd.optional(), timeout: z.number().int().min(1).max(600).optional() }).strict(),
  z.object(locator).strict().refine((v) => v.action !== "fill" || v.text !== undefined),
]);
export const CommandSchema = z.discriminatedUnion("operation", [
  ...["session.start", "session.status", "session.stop"].map((op) => z.object({ ...base, operation: z.literal(op), generation: generation.optional() }).strict()),
  ...["agent.create", "agent.delete"].map((op) => z.object({ ...base, operation: z.literal(op) }).strict()),
  ...input.map((v) => z.object({ ...running, ...v }).strict()),
  z.object({ ...running, operation: z.literal("capture.screenshot"), crop: crop.optional() }).strict(),
  z.object({ ...running, operation: z.literal("browser.pages") }).strict(),
  z.object({ ...running, operation: z.literal("page.snapshot"), pageId: uuid.optional() }).strict(),
  z.object({ ...running, operation: z.literal("page.verify"), predicate: verificationPredicate }).strict(),
  z.object({ ...running, operation: z.literal("file.open"), name: fileName }).strict(),
  z.object({ ...running, operation: z.literal("shell.run"), command: shellCommand, cwd: shellCwd.optional(), timeout: z.number().int().min(1).max(600).optional() }).strict(),
  z.object({ ...running, ...locator }).strict().refine((v) => v.action !== "fill" || v.text !== undefined),
]);
const control = { ...running, sessionRef: z.string().regex(/^[0-9a-f]{64}$/), connectionId: uuid };
export const TakeoverSchema = z.discriminatedUnion("operation", [z.object({ ...control, operation: z.literal("takeover") }).strict(), z.object({ ...control, operation: z.literal("handback"), leaseId: uuid }).strict()]);
export const OwnerInputSchema = z.discriminatedUnion("operation", input.map((v) => z.object({ ...control, leaseId: uuid, ...v }).strict()));
export const WorkerOperationSchema = z.object({
  command: z.literal("operation"),
  requestId: uuid,
  operation: z.string().min(1),
  params: z.unknown(),
  ownerInput: z.literal(true).optional(),
}).strict();
export const StreamSchema = z.object({ ownerId: uuid, generation, sessionRef: control.sessionRef, connectionId: uuid }).strict();
export const TeachSchema = z.object({ ...control, leaseId: uuid, captureId: uuid, action: z.enum(['start','status','pause','resume','stop','discard','artifact','audio']), narration: z.boolean().optional(), timezone: z.string().min(1).max(64).refine(v => {try {new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}}).optional(), hash: z.string().regex(/^[0-9a-f]{64}$/).optional(), base64: z.string().max(4194304).regex(/^[A-Za-z0-9+/]+={0,2}$/).optional(), sequence: z.number().int().min(0).max(299).optional(), offsetMs: z.number().int().min(0).max(120000).optional(), mime: z.enum(['audio/webm','audio/webm;codecs=opus','audio/ogg','audio/ogg;codecs=opus','audio/wav']).optional() }).strict().superRefine((v,c) => { if (v.action === 'artifact' && !v.hash || v.action === 'audio' && (!v.base64 || v.sequence === undefined || v.offsetMs === undefined || !v.mime)) c.addIssue({code:'custom',message:'missing_fields'}); });
const tagged = { source_tag: z.literal("tool"), untrusted: z.literal(true) };
const ok = z.object({ ok: z.literal(true) }).strict();
const box = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().nonnegative().finite(), height: z.number().nonnegative().finite() }).strict();
const png = z.object({ width: z.number().int().min(1).max(1024), height: z.number().int().min(1).max(768), base64: z.string().max(5592408).regex(/^[A-Za-z0-9+/]+={0,2}$/), ...tagged }).strict();
const page = z.object({ pageId: uuid, href: z.string().max(2048), title: z.string().max(1024) }).strict();
const pages = z.object({ pages: z.array(page).max(32), ...tagged }).strict();
// Names come from an untrusted page: bounded, no control characters. Positions are screen pixels inside the 1024x768 display.
const snapshotElement = z.object({ ref: z.number().int().min(1).max(150), role: z.string().regex(/^[a-z]{1,32}$/), name: z.string().max(80).refine((v) => !/[\x00-\x1f\x7f-\x9f]/.test(v)),
  tag: z.string().regex(/^[a-z0-9-]{1,32}$/), focused: z.boolean().optional(), x: z.number().int().min(0).max(1023), y: z.number().int().min(0).max(767), width: z.number().int().min(1).max(1024), height: z.number().int().min(1).max(768) }).strict()
  .refine((v) => v.x + v.width <= 1024 && v.y + v.height <= 768);
const snapshot = z.object({ pageId: uuid, href: z.string().max(2048), title: z.string().max(1024), frames: z.number().int().min(0).max(64),
  elements: z.array(snapshotElement).max(150), ...tagged }).strict();
const inspect = z.object({ tag: z.string().max(64), text: z.string().max(4096), boundingBox: box.nullable(), ...tagged }).strict();
const shellResult = z.object({ exit: z.number().int().min(-256).max(256), signal: z.string().max(32).nullable(), timedOut: z.boolean(), stdout: z.string().max(16384), stderr: z.string().max(16384), truncated: z.boolean(), ...tagged }).strict();
export const SessionResultSchema = z.object({ agentId: uuid, state: z.enum(["starting", "running", "stopping", "stopped", "failed"]), display: z.number().int().optional(), reason: z.string().max(64).optional(), generation: generation.optional(), vncPort: z.number().int().min(1).max(65535).optional(), vncReady: z.boolean().optional(), takenOver: z.boolean().optional() }).strict();
export function operationFields(value) {
  const { ownerId: _o, agentId: _a, generation: _g, requestId: _r, sessionRef: _s, connectionId: _c, leaseId: _l, ...fields } = value;
  void _o; void _a; void _g; void _r; void _s; void _c; void _l; return OperationSchema.parse(fields);
}
export function validatePng(buffer, expected) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || buffer.length > 4 * 1024 * 1024 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || buffer.toString("ascii", 12, 16) !== "IHDR") throw Error("invalid_png");
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (width < 1 || width > 1024 || height < 1 || height > 768 || expected && (width !== expected.width || height !== expected.height)) throw Error("invalid_png");
  return { width, height };
}
export function resultFor(operation, result, params = {}) {
  if (operation === "capture.screenshot") {
    const value = png.parse(result); const bytes = Buffer.from(value.base64, "base64");
    if (bytes.toString("base64") !== value.base64) throw Error("invalid_png");
    validatePng(bytes, params.crop ?? { width: 1024, height: 768 }); return value;
  }
  if (operation === "browser.pages") return pages.parse(result);
  if (operation === "page.snapshot") return snapshot.parse(result);
  if (operation === "page.verify") return pageVerificationResult.parse(result);
  if (operation === "browser.locator" && params.action === "inspect") return inspect.parse(result);
  if (operation === "shell.run") return shellResult.parse(result);
  return ok.parse(result);
}
export const ResultSchema = z.union([SessionResultSchema, png, pages, snapshot, pageVerificationResult, inspect, shellResult, ok]);
export const parseCommand = (value) => CommandSchema.parse(value);
export const parseResult = (value) => ResultSchema.parse(value);
