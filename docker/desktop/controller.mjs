import http from "node:http";
import dns from "node:dns/promises";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import { TeachSchema, CommandSchema, OwnerInputSchema, TakeoverSchema, StreamSchema, UUID_PATTERN } from "./controller-schema.mjs";
import { bridgeRfb } from "./rfb-bridge.mjs";

const MAX_BODY = 16384;
const SAFE_CODES = new Set(["page_busy", "option_not_found", "terminal_requires_shell", "unknown_window", "auth_failed", "source_denied", "invalid_command", "invalid_json", "body_too_large", "not_found", "method_not_allowed", "invalid_content_type", "agent_unavailable", "session_not_running", "session_start_failed", "session_start_timeout", "session_cleanup_failed", "stale_generation", "takeover_active", "takeover_conflict", "invalid_lease", "not_in_takeover", "capture_blocked_during_takeover", "viewer_not_active", "viewer_limit", "stream_unavailable", "duplicate_request_id", "queue_full", "uncertain_outcome", "invalid_worker_result", "sensitive_target", "focused_target_unknown", "too_many_pages", "too_many_frames", "page_not_found", "target_not_found", "navigation_failed", "desktop_command_failed", "desktop_result_too_large", "forbidden_target", "unknown_page", "ambiguous_locator", "grounding_unavailable", "visual_unavailable", "invalid_png", "operation_failed", "display_conflict", "profile_busy_or_unsafe", "supervisor_stopping", "desktop_start_failed", "desktop_stop_failed", "browser_start_failed", "browser_stop_failed", "desktop_setup_failed", "desktop_not_running", "browser_not_running", "sandbox_start_failed", "agent_paused", "security_stopped", "budget_exhausted"]);
export const safeCode = (error) => SAFE_CODES.has(error?.code) ? error.code : "operation_failed";
const reply = (res, status, value) => {
  if (res.headersSent || res.destroyed) return;
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > 8 * 1024 * 1024) return reply(res, 502, { outcome: "error", code: "invalid_worker_result" });
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(body);
};
async function readBody(req, limit = MAX_BODY) {
  const declared = req.headers["content-length"];
  if (declared !== undefined && (!/^[0-9]+$/.test(declared) || +declared > limit)) throw Object.assign(Error(), { code: "body_too_large" });
  let size = 0; const chunks = [];
  const timer = setTimeout(() => req.destroy(), 2000);
  try {
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(Error(), { code: "body_too_large" }); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Object.assign(Error(), { code: "invalid_json" }); }
  } finally { clearTimeout(timer); }
}
// Shared by every listener on this container: only the app (by address) holding the secret may call.
export function createAuthenticator(secret, resolveApp = () => dns.lookup("app", { all: true })) {
  if (!/^[0-9a-f]{64}$/.test(secret ?? "")) throw Error("invalid_secret");
  const secretBytes = Buffer.from(secret, "hex");
  return async function authenticate(req) {
    if (req.headers.origin !== undefined) return "source_denied";
    const address = req.socket.remoteAddress?.replace(/^::ffff:/, ""); let addresses; let timer;
    try { addresses = await Promise.race([resolveApp(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error()), 1000); })]); }
    catch { return "source_denied"; } finally { clearTimeout(timer); }
    if (!Array.isArray(addresses) || addresses.length > 16 || !addresses.some((item) => item.address === address)) return "source_denied";
    const token = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization ?? "")?.[1];
    if (!token || !timingSafeEqual(secretBytes, Buffer.from(token, "hex"))) return "auth_failed";
    return null;
  };
}
export function createController(manager, secret, { resolveApp = () => dns.lookup("app", { all: true }) } = {}) {
  const authenticate = createAuthenticator(secret, resolveApp);
  const server = http.createServer(async (req, res) => {
    try {
      const denied = await authenticate(req); if (denied) return reply(res, denied === "auth_failed" ? 401 : 403, { outcome: "error", code: denied });
      if (req.method !== "POST") return reply(res, 405, { outcome: "error", code: "method_not_allowed" });
      if ((req.headers["content-type"] ?? "").split(";")[0].trim() !== "application/json") return reply(res, 415, { outcome: "error", code: "invalid_content_type" });
      const match = /^\/v1\/agents\/([^/]+)\/(commands|takeover|handback|input|teach)$/.exec(req.url ?? "");
      if (!match || !UUID_PATTERN.test(match[1])) return reply(res, 404, { outcome: "error", code: "not_found" });
      const raw = await readBody(req, match[2] === "teach" ? 4 * 1024 * 1024 + 4096 : MAX_BODY); const kind = match[2]; let parsed;
      if (kind === "teach") parsed = TeachSchema.safeParse(raw);
      else if (kind === "commands") parsed = CommandSchema.safeParse(raw);
      else if (kind === "input") parsed = OwnerInputSchema.safeParse(raw);
      else if (raw && typeof raw === "object" && !Object.hasOwn(raw, "operation")) parsed = TakeoverSchema.safeParse({ ...raw, operation: kind });
      else parsed = { success: false };
      if (!parsed.success || parsed.data.agentId !== match[1]) return reply(res, 400, { outcome: "error", code: "invalid_command" });
      const c = parsed.data; let result;
      if (kind === "teach") result = await manager.teach(c.ownerId, c.agentId, c);
      else if (kind === "takeover") result = await manager.takeOver(c.ownerId, c.agentId, c);
      else if (kind === "handback") result = await manager.handBack(c.ownerId, c.agentId, c);
      else if (kind === "input") result = await manager.ownerInput(c.ownerId, c.agentId, c.operation, c, c);
      else if (c.operation === "session.start") result = await manager.start(c.ownerId, c.agentId);
      else if (c.operation === "session.stop") result = await manager.stop(c.ownerId, c.agentId, c.generation);
      else if (c.operation === "session.status") result = await manager.status(c.ownerId, c.agentId);
      else if (c.operation === "sandbox.start") result = await manager.ensureSandbox(c.ownerId, c.agentId);
      else if (c.operation === "desktop.start") result = await manager.startDesktop(c.ownerId, c.agentId, c.generation);
      else if (c.operation === "desktop.stop") result = await manager.stopDesktop(c.ownerId, c.agentId, c.generation);
      else if (c.operation === "browser.start") result = await manager.startBrowser(c.ownerId, c.agentId, c.generation);
      else if (c.operation === "browser.stop") result = await manager.stopBrowser(c.ownerId, c.agentId, c.generation);
      else if (c.operation === "agent.create") {
        const created = await manager.create(c.ownerId, c.agentId);
        if (created.agentId !== c.agentId) throw Error("invalid_agent_result");
        result = { agentId: c.agentId, state: "ready" };
      } else if (c.operation === "agent.delete") {
        const deleted = await manager.delete(c.ownerId, c.agentId);
        if (deleted.agentId !== c.agentId) throw Error("invalid_agent_result");
        result = { agentId: c.agentId };
      } else result = await manager.executeOperation(c.ownerId, c.agentId, c.generation, c.requestId, c.operation, c);
      reply(res, 200, { outcome: "ok", result });
    } catch (error) {
      const code = safeCode(error); const status = ["invalid_json", "invalid_command"].includes(code) ? 400 : code === "body_too_large" ? 413 : code === "agent_unavailable" ? 404 : 409;
      reply(res, status, { outcome: "error", code });
    }
  });
  server.maxConnections = 64; server.headersTimeout = 5000; server.requestTimeout = 5000; server.keepAliveTimeout = 5000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false, clientTracking: false });
  const connections = new Set();
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    void (async () => {
      let unregister; let bridge; let ws; let ping; let done = false;
      const close = () => { if (done) return; done = true; clearInterval(ping); connections.delete(close); unregister?.(); bridge?.close(); ws?.terminate(); socket.destroy(); };
      try {
        const denied = await authenticate(req);
        if (denied || connections.size >= 32) { socket.write(`HTTP/1.1 ${denied === "auth_failed" ? 401 : 403} Denied\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`); socket.end(); return; }
        const url = new URL(req.url ?? "", "http://desktop"); const match = /^\/v1\/agents\/([^/]+)\/stream$/.exec(url.pathname);
        if (!match || !UUID_PATTERN.test(match[1]) || url.hash || [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1)) throw Error();
        const control = StreamSchema.parse(Object.fromEntries(url.searchParams)); const agentId = match[1];
        const info = manager.streamInfo(control.ownerId, agentId, control);
        unregister = manager.registerViewer(control.ownerId, agentId, control, close); connections.add(close);
        socket.once("close", close);
        wss.handleUpgrade(req, socket, head, (client) => {
          ws = client; client.on("error", close); client.once("close", close);
          let alive = true; client.on("pong", () => { alive = true; });
          ping = setInterval(() => { if (!alive) return close(); alive = false; try { client.ping(); } catch { close(); } }, 5000);
          bridge = bridgeRfb(client, info); bridge.ready.catch(close);
        });
      } catch { close(); }
    })();
  });
  server.closeControllerStreams = () => { for (const close of connections) close(); };
  server.once("close", () => { server.closeControllerStreams(); wss.close(); });
  return server;
}
