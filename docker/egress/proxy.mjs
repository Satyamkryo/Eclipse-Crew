import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import dns from "node:dns/promises";
import { createServer } from "node:http";
import https from "node:https";
import net from "node:net";
import { fileURLToPath } from "node:url";

import { createRegistry, POLICY_TTL_MS } from "./registry.mjs";
import { createEventLog } from "./events.mjs";
import { isBlockedAddress } from "./addresses.mjs";
import { canaryHash, findCanary } from "./canary.mjs";
import { CredentialError, createCredentialStore } from "./credentials.mjs";
import { DEVICE_HOST, MAX_DEVICE_BODY, parseDeviceRequest, sanitizeDeviceResponse } from "./github-device.mjs";

export { isBlockedAddress };

// TASK-046: forwards the app's model-provider requests to the internet and injects the API key.
// The key arrives in a header from `app` over the private network, is used for one upstream request,
// and is never stored, logged or returned. Public HTTPS destinations only.
// TASK-045: the same process also hosts the desktop browser's CONNECT proxy on 4321 and receives
// per-agent allowlists on POST /v1/policy (authenticated with EGRESS_PROXY_SECRET).

export const MAX_BODY_BYTES = 9 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const TOTAL_TIMEOUT_MS = 60_000;
export const MAX_ACTIVE = 8;
export const MAX_TOOL_ACTIVE = 4;
export const MAX_TOOL_BODY_BYTES = 4 * 1024 * 1024;
export const REDACTION = "[redacted]";

export class ProxyError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

export function parseTarget(value) {
  let url;
  try { url = new URL(value); } catch { throw new ProxyError("forbidden_target", 403); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443") ||
      net.isIP(host.replace(/^\[|\]$/g, "")) || host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(host) ||
      url.pathname.length + url.search.length > 2048 || /[\\\u0000-\u001f\u007f]/.test(value)) {
    throw new ProxyError("forbidden_target", 403);
  }
  return { host, path: `${url.pathname}${url.search}` };
}

const digest = (value) => createHash("sha256").update(value).digest();
export function secretMatches(provided, expected) {
  return typeof provided === "string" && timingSafeEqual(digest(provided), digest(expected));
}

// Must stay identical to the domain rule in lib/agents/schema.ts (tests compare both).
export const POLICY_DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANARY_HASH = /^[0-9a-f]{64}$/;
const GIT_SITE = /^github\.com\/[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const ACTION_CLASS = new Set(["download", "send", "post", "delete", "purchase", "submit"]);
const POLICY_KEYS = new Set(["agentId", "anyPublic", "blocked", "canaryHashes", "clearTrip", "domains", "trip"]);

export function validatePolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProxyError("invalid_policy", 400);
  if (Object.keys(value).some((key) => !POLICY_KEYS.has(key))) throw new ProxyError("invalid_policy", 400);
  if (typeof value.agentId !== "string" || !AGENT_ID.test(value.agentId)) throw new ProxyError("invalid_policy", 400);
  if (typeof value.blocked !== "boolean" || !Array.isArray(value.domains) || value.domains.length > 64) throw new ProxyError("invalid_policy", 400);
  const canaryHashes = value.canaryHashes ?? [];
  if (!Array.isArray(canaryHashes) || canaryHashes.length > 4 ||
      canaryHashes.some((hash) => typeof hash !== "string" || !CANARY_HASH.test(hash))) throw new ProxyError("invalid_policy", 400);
  if (value.trip !== undefined && typeof value.trip !== "boolean") throw new ProxyError("invalid_policy", 400);
  if (value.clearTrip !== undefined && typeof value.clearTrip !== "boolean") throw new ProxyError("invalid_policy", 400);
  if (value.trip && value.clearTrip) throw new ProxyError("invalid_policy", 400);
  // ADR-036. Any public host; isBlockedAddress still refuses internal, LAN and metadata targets on every connection.
  if (value.anyPublic !== undefined && typeof value.anyPublic !== "boolean") throw new ProxyError("invalid_policy", 400);
  const domains = value.domains.map((domain) => {
    if (typeof domain !== "string") throw new ProxyError("invalid_policy", 400);
    const normalized = domain.trim().toLowerCase();
    if (normalized.length > 253 || !POLICY_DOMAIN.test(normalized)) throw new ProxyError("invalid_policy", 400);
    return normalized;
  });
  return { agentId: value.agentId.toLowerCase(), domains, anyPublic: value.anyPublic === true, blocked: value.blocked,
    canaryHashes: canaryHashes.map((hash) => hash.toLowerCase()), trip: value.trip === true, clearTrip: value.clearTrip === true };
}

const TOKEN_HEADER = /^[\x21-\x7e]{8,4096}$/;
const SIMPLE_HEADER = /^[\w.+\-/ ;=,*]{1,128}$/;

async function readBody(request, maxBytes = MAX_BODY_BYTES) {
  const declared = request.headers["content-length"];
  if (declared !== undefined && (!/^\d{1,10}$/.test(declared) || Number(declared) > maxBytes)) throw new ProxyError("body_too_large", 413);
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new ProxyError("body_too_large", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function redact(body, credential) {
  if (!credential) return body;
  return Buffer.from(body.toString("latin1").split(credential).join(REDACTION), "latin1");
}

// TASK-070. A tool response may echo the token in any of the encodings a server is likely to use. The proxy strips all
// of them before the body reaches the app, the model or a history entry.
export function redactAll(body, entry) {
  if (!entry) return body;
  const variants = new Set([entry.token]);
  try { variants.add(Buffer.from(entry.token, "utf8").toString("base64")); } catch { /* ignore */ }
  try { variants.add(encodeURIComponent(entry.token)); } catch { /* ignore */ }
  if (entry.scheme === "basic" && entry.username) {
    variants.add(Buffer.from(`${entry.username}:${entry.token}`, "utf8").toString("base64"));
  }
  let text = body.toString("latin1");
  let changed = false;
  for (const variant of variants) {
    if (!variant) continue;
    if (text.includes(variant)) { text = text.split(variant).join(REDACTION); changed = true; }
  }
  return changed ? Buffer.from(text, "latin1") : body;
}

// TASK-070. Only the proxy ever turns a stored entry into an authorization header.
export function injectCredential(headers, entry) {
  if (!entry) return headers;
  if (entry.scheme === "bearer") headers.authorization = `Bearer ${entry.token}`;
  else if (entry.scheme === "basic") {
    headers.authorization = `Basic ${Buffer.from(`${entry.username ?? ""}:${entry.token}`, "utf8").toString("base64")}`;
  } else if (entry.scheme === "header" && entry.header) headers[entry.header] = entry.token;
  return headers;
}

async function resolvePublic(host, resolve) {
  let addresses;
  try { addresses = await resolve(host); } catch { throw new ProxyError("upstream_error", 502); }
  if (!addresses.length || addresses.some(({ address }) => isBlockedAddress(address))) throw new ProxyError("forbidden_target", 403);
  return addresses[0];
}

function forwardUpstream({ upstream, host, path, method, headers, body, address, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    const request = upstream({
      host, port: 443, method, path, headers, servername: host, signal, timeout: timeoutMs,
      // Connect to the address that was already checked, so a second lookup cannot change it.
      // Node 24 asks for `all: true` (an array) when it picks between address families.
      autoSelectFamily: false,
      lookup: (_name, options, callback) => options?.all
        ? callback(null, [{ address: address.address, family: address.family }])
        : callback(null, address.address, address.family),
    }, (response) => {
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) { response.destroy(); finish(reject, new ProxyError("response_too_large", 502)); return; }
        chunks.push(chunk);
      });
      response.on("end", () => finish(resolve, { status: response.statusCode, contentType: response.headers["content-type"], headers: response.headers, body: Buffer.concat(chunks) }));
      response.on("error", () => finish(reject, new ProxyError("upstream_error", 502)));
    });
    request.on("error", () => finish(reject, signal.aborted ? new ProxyError("upstream_timeout", 504) : new ProxyError("upstream_error", 502)));
    request.on("timeout", () => { request.destroy(); finish(reject, new ProxyError("upstream_timeout", 504)); });
    signal.addEventListener("abort", () => { request.destroy(); finish(reject, new ProxyError("upstream_timeout", 504)); }, { once: true });
    request.end(body.length ? body : undefined);
  });
}

export function createProxy({ secret, registry, credentials = null, events = createEventLog(), resolve = (host) => dns.lookup(host, { all: true, verbatim: true }), upstream = https.request,
  log = (event) => console.log(JSON.stringify(event)), timeoutMs = TOTAL_TIMEOUT_MS } = {}) {
  const configured = typeof secret === "string" && /^[0-9a-f]{64}$/.test(secret);
  let active = 0;
  let toolActive = 0;
  const server = createServer(async (request, response) => {
    const send = (status, body, headers = {}) => {
      response.writeHead(status, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
      response.end(body);
    };
    const refuse = (error) => send(error.status, JSON.stringify({ error: error.code }), { "Content-Type": "application/json", "X-Eclipse-Proxy": "error" });
    try {
      const path = (request.url ?? "").split("?")[0];
      if (path === "/healthz" && request.method === "GET") return send(configured ? 200 : 503, JSON.stringify({ ok: configured }), { "Content-Type": "application/json" });
      if (!configured) throw new ProxyError("not_configured", 503);
      const authorization = request.headers.authorization ?? "";
      if (!authorization.startsWith("Bearer ") || !secretMatches(authorization.slice(7), secret)) throw new ProxyError("unauthorized", 401);
      if (path === "/v1/events") {
        if (request.method !== "GET") throw new ProxyError("not_found", 404);
        const rawAfter = new URL(request.url ?? "/v1/events", "http://proxy.local").searchParams.get("after");
        const after = rawAfter === null ? 0 : Number(rawAfter);
        if (!Number.isSafeInteger(after) || after < 0) throw new ProxyError("invalid_after", 400);
        return send(200, JSON.stringify({ boot: events.boot, events: events.after(after) }), { "Content-Type": "application/json", "X-Eclipse-Proxy": "ok" });
      }
      if (path === "/v1/credentials") {
        if (request.method !== "POST" || !credentials) throw new ProxyError("not_found", 404);
        const raw = await readBody(request, 32 * 1024);
        let body;
        try { body = JSON.parse(raw.toString("utf8")); } catch { throw new ProxyError("invalid_credentials", 400); }
        if (!body || typeof body !== "object" || Array.isArray(body) ||
            Object.keys(body).some((key) => key !== "agentId" && key !== "credentials") ||
            typeof body.agentId !== "string" || !AGENT_ID.test(body.agentId)) {
          throw new ProxyError("invalid_credentials", 400);
        }
        let version;
        try { version = credentials.set(body.agentId.toLowerCase(), body.credentials); }
        catch (error) {
          if (error instanceof CredentialError) throw new ProxyError("invalid_credentials", 400);
          throw error;
        }
        return send(200, JSON.stringify({ ok: true, credentialsVersion: version }), { "Content-Type": "application/json", "X-Eclipse-Proxy": "ok" });
      }
      // TASK-073c. Authenticated app-only controls for blocked pushes. The browser never calls
      // these routes; the app verifies ownership and supplies the agent id.
      if (path === "/v1/pending") {
        if (request.method !== "GET" || !registry) throw new ProxyError("not_found", 404);
        const params = new URL(request.url ?? "/v1/pending", "http://proxy.local").searchParams;
        if ([...params.keys()].length !== 1 || !params.has("agentId")) throw new ProxyError("invalid_agent", 400);
        const agentId = String(params.get("agentId") ?? "").toLowerCase();
        if (!AGENT_ID.test(agentId)) throw new ProxyError("invalid_agent", 400);
        return send(200, JSON.stringify({ pending: registry.listPending(agentId) }), { "Content-Type": "application/json", "X-Eclipse-Proxy": "ok" });
      }
      if (path === "/v1/grants") {
        if (!registry) throw new ProxyError("not_found", 404);
        if (request.method === "POST") {
          const raw = await readBody(request, 4096);
          let body;
          try { body = JSON.parse(raw.toString("utf8")); } catch { throw new ProxyError("invalid_grant", 400); }
          if (!body || typeof body !== "object" || Array.isArray(body) ||
              Object.keys(body).length !== 2 || typeof body.agentId !== "string" || typeof body.pendingId !== "string" ||
              !AGENT_ID.test(body.agentId) || !AGENT_ID.test(body.pendingId)) {
            throw new ProxyError("invalid_grant", 400);
          }
          const result = registry.grantPending(body.agentId.toLowerCase(), body.pendingId.toLowerCase());
          if (!result.ok) {
            const status = result.error === "not_found" ? 404 : 409;
            throw new ProxyError(result.error, status);
          }
          return send(200, JSON.stringify({ grant: result.grant }), { "Content-Type": "application/json", "X-Eclipse-Proxy": "ok" });
        }
        if (request.method === "DELETE") {
          const params = new URL(request.url ?? "/v1/grants", "http://proxy.local").searchParams;
          const keys = [...params.keys()].sort();
          if (keys.join(",") !== "actionClass,agentId,site") throw new ProxyError("invalid_revoke", 400);
          const agentId = String(params.get("agentId") ?? "").toLowerCase();
          const site = String(params.get("site") ?? "").toLowerCase();
          const actionClass = String(params.get("actionClass") ?? "");
          if (!AGENT_ID.test(agentId) || !GIT_SITE.test(site) || !ACTION_CLASS.has(actionClass)) throw new ProxyError("invalid_revoke", 400);
          const revoked = registry.revokeGrants(agentId, site, actionClass);
          return send(200, JSON.stringify({ ok: true, revoked }), { "Content-Type": "application/json", "X-Eclipse-Proxy": "ok" });
        }
        throw new ProxyError("not_found", 404);
      }
      if (path === "/v1/git-approvals") {
        if (request.method !== "DELETE" || !registry) throw new ProxyError("not_found", 404);
        const params = new URL(request.url ?? "/v1/git-approvals", "http://proxy.local").searchParams;
        if ([...params.keys()].length !== 1 || !params.has("agentId")) throw new ProxyError("invalid_agent", 400);
        const agentId = String(params.get("agentId") ?? "").toLowerCase();
        if (!AGENT_ID.test(agentId)) throw new ProxyError("invalid_agent", 400);
        registry.clearAgent(agentId);
        return send(200, JSON.stringify({ ok: true }), { "Content-Type": "application/json", "X-Eclipse-Proxy": "ok" });
      }
      const pendingMatch = /^\/v1\/pending\/([0-9a-f-]{36})$/.exec(path);
      if (pendingMatch) {
        if (request.method !== "DELETE" || !registry) throw new ProxyError("not_found", 404);
        const params = new URL(request.url ?? "/", "http://proxy.local").searchParams;
        if ([...params.keys()].length !== 1 || !params.has("agentId")) throw new ProxyError("invalid_agent", 400);
        const agentId = String(params.get("agentId") ?? "").toLowerCase();
        const pendingId = pendingMatch[1].toLowerCase();
        if (!AGENT_ID.test(agentId) || !AGENT_ID.test(pendingId)) throw new ProxyError("invalid_agent", 400);
        if (!registry.denyPending(agentId, pendingId)) return send(404, JSON.stringify({ error: "not_found" }), { "Content-Type": "application/json", "X-Eclipse-Proxy": "error" });
        return send(200, JSON.stringify({ ok: true }), { "Content-Type": "application/json", "X-Eclipse-Proxy": "ok" });
      }
      // TASK-088. A GitHub App device sign-in uses the only two fixed GitHub endpoints listed below. The host and
      // paths cannot be changed by the caller, so this is not a general outbound path. Tokens are returned to the
      // app (which encrypts them) and are never logged or written to the event log.
      if (path === "/v1/github-device") {
        if (request.method !== "POST") throw new ProxyError("not_found", 404);
        const raw = await readBody(request, MAX_DEVICE_BODY);
        let device;
        try { device = parseDeviceRequest(JSON.parse(raw.toString("utf8"))); }
        catch { throw new ProxyError("invalid_device_request", 400); }
        const address = await resolvePublic(DEVICE_HOST, resolve);
        const body = Buffer.from(device.form, "utf8");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        try {
          const result = await forwardUpstream({
            upstream, host: DEVICE_HOST, path: device.path, method: "POST",
            headers: { "user-agent": "eclipse-crew-egress/1", accept: "application/json", "accept-encoding": "identity",
              "content-type": "application/x-www-form-urlencoded", "content-length": String(body.length) },
            body, address, signal: controller.signal, timeoutMs: 15_000,
          });
          let sanitized;
          try { sanitized = sanitizeDeviceResponse(device.operation, JSON.parse(result.body.toString("utf8"))); }
          catch { throw new ProxyError("device_unavailable", 502); }
          return send(200, JSON.stringify(sanitized), { "Content-Type": "application/json", "X-Eclipse-Proxy": "ok" });
        } finally { clearTimeout(timer); }
      }
      if (path === "/v1/tool-forward") {
        if (request.method !== "POST") throw new ProxyError("not_found", 404);
        const agentId = String(request.headers["x-eclipse-agent"] ?? "").toLowerCase();
        if (!AGENT_ID.test(agentId)) throw new ProxyError("agent_unavailable", 403);
        const policy = registry?.get(agentId);
        if (!policy || policy.blocked || policy.tripped) throw new ProxyError("agent_unavailable", 403);
        const toolMethod = request.headers["x-eclipse-method"];
        if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(toolMethod)) throw new ProxyError("invalid_request", 400);
        const { host, path: toolPath } = parseTarget(String(request.headers["x-eclipse-target"] ?? ""));
        const toolBody = await readBody(request, MAX_TOOL_BODY_BYTES);
        for (const value of [String(request.headers["x-eclipse-target"] ?? ""), toolPath, toolBody.toString("utf8")]) {
          const candidate = findCanary(value);
          if (!candidate) continue;
          const owner = registry.tripByCanary(canaryHash(candidate));
          if (!owner) continue;
          registry.trip(owner);
          events?.push({ agentId: owner, source: "proxy_request" });
          log({ event: "canary_trip", agent: owner, reason: "canary_leak", source: "proxy_request" });
          throw new ProxyError("canary_blocked", 403);
        }
        if (toolActive >= MAX_TOOL_ACTIVE) throw new ProxyError("busy", 503);
        toolActive += 1;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const credential = credentials?.lookup(agentId, host) ?? null;
          const outgoing = { "user-agent": "eclipse-crew-egress/1", "accept-encoding": "identity" };
          for (const name of ["content-type", "accept", "mcp-session-id", "mcp-protocol-version"]) {
            const value = request.headers[name];
            if (value !== undefined) {
              if (typeof value !== "string" || !SIMPLE_HEADER.test(value)) throw new ProxyError("invalid_request", 400);
              outgoing[name] = value;
            }
          }
          injectCredential(outgoing, credential);
          if (toolMethod === "GET" && toolBody.length) throw new ProxyError("invalid_request", 400);
          outgoing["content-length"] = String(toolBody.length);
          const address = await resolvePublic(host, resolve);
          const result = await forwardUpstream({
            upstream, host, path: toolPath, method: toolMethod, headers: outgoing, body: toolBody,
            address, signal: controller.signal, timeoutMs,
          });
          const clean = redactAll(result.body, credential);
          const type = typeof result.contentType === "string" && SIMPLE_HEADER.test(result.contentType) ? result.contentType : "application/octet-stream";
          const headers = { "Content-Type": type, "X-Eclipse-Proxy": "ok" };
          for (const name of ["mcp-session-id", "retry-after"]) {
            const value = result.headers?.[name];
            if (typeof value === "string" && SIMPLE_HEADER.test(value)) headers[name] = value;
          }
          return send(result.status, clean, headers);
        } finally { clearTimeout(timer); toolActive -= 1; }
      }
      if (!["/v1/forward", "/v1/teach-asr", "/v1/policy"].includes(path) || request.method !== "POST") throw new ProxyError("not_found", 404);
      if (active >= MAX_ACTIVE) throw new ProxyError("busy", 503);
      active += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        if (path === "/v1/policy") {
          if (!registry) throw new ProxyError("not_found", 404);
          const raw = await readBody(request, 64 * 1024);
          let body;
          try { body = JSON.parse(raw.toString("utf8")); } catch { throw new ProxyError("invalid_policy", 400); }
          const policy = validatePolicy(body);
          const result = registry.setPolicy(policy.agentId, policy.domains, policy.blocked,
            { canaryHashes: policy.canaryHashes, trip: policy.trip, clearTrip: policy.clearTrip, anyPublic: policy.anyPublic });
          return send(200, JSON.stringify({ ok: true, expiresInMs: POLICY_TTL_MS, tripped: result.tripped,
            credentialsVersion: credentials?.version(policy.agentId) ?? null }), { "Content-Type": "application/json", "X-Eclipse-Proxy": "ok" });
        }
        const audio = path === "/v1/teach-asr";
        const method = audio ? "POST" : request.headers["x-eclipse-method"];
        if (method !== "GET" && method !== "POST") throw new ProxyError("forbidden_target", 403);
        const { host, path: targetPath } = parseTarget(audio ? "https://api.meta.ai/v1/asr/transcribe" : String(request.headers["x-eclipse-target"] ?? ""));
        const credential = request.headers["x-eclipse-credential"];
        if (credential !== undefined && (typeof credential !== "string" || !TOKEN_HEADER.test(credential))) throw new ProxyError("invalid_credential", 400);
        const outgoing = { "user-agent": "eclipse-crew-egress/1", "accept-encoding": "identity" };
        for (const name of ["content-type", "accept"]) {
          const value = request.headers[name];
          if (value !== undefined) { if (typeof value !== "string" || !SIMPLE_HEADER.test(value)) throw new ProxyError("invalid_request", 400); outgoing[name] = value; }
        }
        if (credential) outgoing.authorization = `Bearer ${credential}`;
        let body = await readBody(request, audio ? 3 * 1024 * 1024 : MAX_BODY_BYTES);
        if (audio) {
          if (!credential || request.headers["content-type"] !== "audio/wav" || request.headers["x-eclipse-target"] || request.headers["x-eclipse-method"]) throw new ProxyError("invalid_audio", 400);
          const boundary = "eclipse-asr-" + randomUUID();
          body = audioMultipart(body, boundary);
          outgoing["content-type"] = "multipart/form-data; boundary=" + boundary;
          outgoing.accept = "application/json";
        }
        if (method === "GET" && body.length) throw new ProxyError("invalid_request", 400);
        outgoing["content-length"] = String(body.length);
        const address = await resolvePublic(host, resolve);
        const result = await forwardUpstream({ upstream, host, path: targetPath, method, headers: outgoing, body, address, signal: controller.signal, timeoutMs });
        const clean = redact(result.body, credential);
        const type = typeof result.contentType === "string" && SIMPLE_HEADER.test(result.contentType) ? result.contentType : "application/octet-stream";
        send(result.status, clean, { "Content-Type": type, "X-Eclipse-Proxy": "ok" });
      } finally { clearTimeout(timer); active -= 1; }
    } catch (error) {
      if (error instanceof ProxyError) { if (error.status >= 500) log({ event: "proxy_error", code: error.code }); return refuse(error); }
      log({ event: "proxy_error", code: "internal_error" });
      refuse(new ProxyError("internal_error", 500));
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = timeoutMs + 10_000;
  server.maxHeaderSize = 16 * 1024;
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 4320);
  const events = createEventLog();
  const credentials = createCredentialStore();
  const registry = createRegistry({ onRemove: (agentId) => credentials.remove(agentId) });
  const server = createProxy({ secret: process.env.EGRESS_PROXY_SECRET, registry, credentials, events });
  server.listen(port, "0.0.0.0", () => console.log(JSON.stringify({ event: "listening", port, configured: /^[0-9a-f]{64}$/.test(process.env.EGRESS_PROXY_SECRET ?? "") })));

  const desktopSecret = process.env.EGRESS_DESKTOP_SECRET ?? "";
  let desktop; let gateway;
  if (/^[0-9a-f]{64}$/.test(desktopSecret)) {
    const { createDesktopProxy } = await import("./desktop-proxy.mjs");
    desktop = createDesktopProxy({ desktopSecret, registry, events });
    desktop.listen(4321, "0.0.0.0", () => console.log(JSON.stringify({ event: "listening", port: 4321, desktop: true })));
    // TASK-073b. Internal-only git gateway; the relay adds the agent preface.
    const { createGitGateway } = await import("./git-gateway.mjs");
    gateway = createGitGateway({ desktopSecret, registry, credentials, events });
    await gateway.listen(4322, "0.0.0.0").then(() => console.log(JSON.stringify({ event: "listening", port: 4322, gitGateway: true })))
      .catch(() => console.log(JSON.stringify({ event: "git_gateway", configured: false })));
  } else {
    console.log(JSON.stringify({ event: "desktop_proxy", configured: false }));
  }

  const sweeper = setInterval(() => registry.sweep(), 30_000);
  sweeper.unref();
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
    clearInterval(sweeper);
    registry.closeAll();
    credentials.clear();
    try { desktop?.close(); } catch { /* already closed */ }
    try { gateway?.close(); } catch { /* already closed */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}

export function audioMultipart(wav, boundary = "eclipse-teach-asr-1") {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(boundary)) throw new ProxyError("invalid_audio",400);
  if (wav.length < 44 || wav.length > 3 * 1024 * 1024 || wav.toString("ascii",0,4) !== "RIFF" || wav.toString("ascii",8,12) !== "WAVE" || wav.readUInt32LE(4)!==wav.length-8) throw new ProxyError("invalid_audio",400);
  let fmt=false, data=false;
  for(let offset=12; offset<wav.length;) {
    if(offset+8>wav.length) throw new ProxyError("invalid_audio",400);
    const name=wav.toString("ascii",offset,offset+4), size=wav.readUInt32LE(offset+4), end=offset+8+size;
    if(end>wav.length) throw new ProxyError("invalid_audio",400);
    if(name==="fmt ") { if(fmt || size!==16 || wav.readUInt16LE(offset+8)!==1 || wav.readUInt16LE(offset+10)!==1 || wav.readUInt32LE(offset+12)!==24000 || wav.readUInt32LE(offset+16)!==48000 || wav.readUInt16LE(offset+20)!==2 || wav.readUInt16LE(offset+22)!==16) throw new ProxyError("invalid_audio",400); fmt=true; }
    else if(name==="data") { if(data || !size || size%2) throw new ProxyError("invalid_audio",400); data=true; }
    else if(name!=="JUNK") throw new ProxyError("invalid_audio",400);
    offset=end+(size%2);
    if(offset>wav.length) throw new ProxyError("invalid_audio",400);
  }
  if(!fmt || !data) throw new ProxyError("invalid_audio",400);
  return Buffer.concat([Buffer.from(('--eclipse-teach-asr-1\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n{"mode":"ENDPOINTING","model":"muse-voice-transcribe-1.0","audioEncoding":"WAV"}\r\n--eclipse-teach-asr-1\r\nContent-Disposition: form-data; name="audio"; filename="narration.wav"\r\nContent-Type: audio/wav\r\n\r\n').replaceAll('eclipse-teach-asr-1',boundary)),wav,Buffer.from('\r\n--'+boundary+'--\r\n')]);
}
