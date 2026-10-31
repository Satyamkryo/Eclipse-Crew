import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireDesktopControlSecret } from "../config/server";

const uuid = z.string().uuid();
const FETCH_TIMEOUT_MS = 5000;
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
const envelopeSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ok"), result: z.unknown() }).strict(),
  z.object({ outcome: z.literal("error"), code: z.string().regex(/^[a-z_]{1,64}$/) }).strict(),
]);
async function desktopPost<T>(path: string, body: unknown, resultSchema: z.ZodType<T>, timeoutMs = FETCH_TIMEOUT_MS): Promise<T> {
  const text = JSON.stringify(body);
  if (Buffer.byteLength(text) > 16 * 1024) throw new Error("request_body_too_large");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("desktop_timeout")); }, timeoutMs);
  });
  try {
    const response = await Promise.race([fetch(`${DESKTOP_BASE_URL}${path}`, { method: "POST", redirect: "error", signal: controller.signal,
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
const generationField = { generation: uuid };
const commandParams: Record<string, z.ZodType> = {
  "capture.screenshot": z.object({ crop: z.object({ x: z.number().int().min(0).max(1023), y: z.number().int().min(0).max(767), width: z.number().int().min(1).max(1024), height: z.number().int().min(1).max(768) }).strict().refine((value) => value.x + value.width <= 1024 && value.y + value.height <= 768).optional() }).strict(),
  "input.click": z.object({ button: z.enum(["left", "right", "double"]), x: z.number().int().min(0).max(1023), y: z.number().int().min(0).max(767) }).strict(),
  "input.type": z.object({ text: textSchema }).strict(),
  "input.key": z.object({ key: keySchema }).strict(),
  "input.scroll": z.object({ direction: z.enum(["up", "down", "left", "right"]), count: z.number().int().min(1).max(20) }).strict(),
  "browser.pages": z.object({}).strict(),
  "browser.locator": z.object({ selector: z.string().min(1).max(512).refine((value) => !/[\x00-\x1f\x7f]/.test(value)), pageId: uuid.optional(), action: z.enum(["inspect", "click", "fill"]), text: textSchema.optional() }).strict().refine((v) => v.action !== "fill" || v.text !== undefined),
};
export async function desktopCommand(agentId: string, ownerId: string, generation: string, operation: string, params: Record<string, unknown>): Promise<unknown> {
  if (!Object.hasOwn(commandParams, operation)) throw new Error("invalid_operation");
  const args = commandParams[operation].parse(params) as Record<string, unknown>;
  const result: z.ZodType<unknown> = operation === "capture.screenshot" ? screenshotResult : operation === "browser.pages" ? pagesResult : operation === "browser.locator" && args.action === "inspect" ? locatorResult : inputResult;
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
  return { agentId: result.agentId, state: result.state, ...(result.generation ? { generation: result.generation } : {}) };
}
