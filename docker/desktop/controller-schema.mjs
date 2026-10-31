import { z } from "zod";
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const uuid = z.string().regex(UUID_PATTERN);
const generation = uuid;
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
  { operation: z.literal("input.click"), button: z.enum(["left", "right", "double"]), x: z.number().int().min(0).max(1023), y: z.number().int().min(0).max(767) },
  { operation: z.literal("input.type"), text },
  { operation: z.literal("input.key"), key: z.string().refine(validKey) },
  { operation: z.literal("input.scroll"), direction: z.enum(["up", "down", "left", "right"]), count: z.number().int().min(1).max(20) },
];
const locator = { operation: z.literal("browser.locator"), selector: z.string().min(1).max(512).refine((v) => !/[\x00-\x1f\x7f]/.test(v)), pageId: uuid.optional(), action: z.enum(["inspect", "click", "fill"]), text: text.optional() };
export const OperationSchema = z.discriminatedUnion("operation", [
  ...input.map((v) => z.object(v).strict()),
  z.object({ operation: z.literal("capture.screenshot"), crop: crop.optional() }).strict(),
  z.object({ operation: z.literal("browser.pages") }).strict(),
  z.object(locator).strict().refine((v) => v.action !== "fill" || v.text !== undefined),
]);
export const CommandSchema = z.discriminatedUnion("operation", [
  ...["session.start", "session.status", "session.stop"].map((op) => z.object({ ...base, operation: z.literal(op), generation: generation.optional() }).strict()),
  ...["agent.create", "agent.delete"].map((op) => z.object({ ...base, operation: z.literal(op) }).strict()),
  ...input.map((v) => z.object({ ...running, ...v }).strict()),
  z.object({ ...running, operation: z.literal("capture.screenshot"), crop: crop.optional() }).strict(),
  z.object({ ...running, operation: z.literal("browser.pages") }).strict(),
  z.object({ ...running, ...locator }).strict().refine((v) => v.action !== "fill" || v.text !== undefined),
]);
const control = { ...running, sessionRef: z.string().regex(/^[0-9a-f]{64}$/), connectionId: uuid };
export const TakeoverSchema = z.discriminatedUnion("operation", [z.object({ ...control, operation: z.literal("takeover") }).strict(), z.object({ ...control, operation: z.literal("handback"), leaseId: uuid }).strict()]);
export const OwnerInputSchema = z.discriminatedUnion("operation", input.map((v) => z.object({ ...control, leaseId: uuid, ...v }).strict()));
export const StreamSchema = z.object({ ownerId: uuid, generation, sessionRef: control.sessionRef, connectionId: uuid }).strict();
const tagged = { source_tag: z.literal("tool"), untrusted: z.literal(true) };
const ok = z.object({ ok: z.literal(true) }).strict();
const box = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().nonnegative().finite(), height: z.number().nonnegative().finite() }).strict();
const png = z.object({ width: z.number().int().min(1).max(1024), height: z.number().int().min(1).max(768), base64: z.string().max(5592408).regex(/^[A-Za-z0-9+/]+={0,2}$/), ...tagged }).strict();
const page = z.object({ pageId: uuid, href: z.string().max(2048), title: z.string().max(1024) }).strict();
const pages = z.object({ pages: z.array(page).max(32), ...tagged }).strict();
const inspect = z.object({ tag: z.string().max(64), text: z.string().max(4096), boundingBox: box.nullable(), ...tagged }).strict();
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
  if (operation === "browser.locator" && params.action === "inspect") return inspect.parse(result);
  return ok.parse(result);
}
export const ResultSchema = z.union([SessionResultSchema, png, pages, inspect, ok]);
export const parseCommand = (value) => CommandSchema.parse(value);
export const parseResult = (value) => ResultSchema.parse(value);
