import dns from "node:dns/promises";
import { createServer } from "node:http";
import net from "node:net";

import { isBlockedAddress } from "./addresses.mjs";
import { canaryHash, findCanary } from "./canary.mjs";
import { egressToken, tokenMatches } from "./registry.mjs";

// TASK-045: the desktop browser's only way out. Chromium talks HTTP proxying to this listener
// (CONNECT for HTTPS, a 307 upgrade for plain HTTP). The agent is identified by a per-agent HMAC
// token; the destination must be in that agent's pushed allowlist and must not resolve to a
// private, loopback, link-local, CGNAT or metadata address.

export const HOSTNAME_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const AGENT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const CONNECT_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 120_000;
const LIFETIME_MS = 30 * 60 * 1000;

function normalizedHost(value) {
  const host = value.toLowerCase().replace(/\.$/, "");
  if (host.length > 253 || net.isIP(host) || !HOSTNAME_PATTERN.test(host)) return null;
  return host;
}

export function parseConnectTarget(value) {
  if (typeof value !== "string" || value.length > 260 || /[\u0000-\u001f\u007f\\]/.test(value)) return null;
  const match = /^([^:\s/]+):443$/.exec(value);
  return match ? normalizedHost(match[1]) : null;
}

export function parseHttpTarget(value) {
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f\u007f\\]/.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "http:" || url.username || url.password || url.hash || (url.port && url.port !== "80")) return null;
  const host = normalizedHost(url.hostname);
  if (!host || url.pathname.length + url.search.length > 2048) return null;
  return { host, path: `${url.pathname}${url.search}` };
}

export function readBasicAgent(value, desktopSecret) {
  if (typeof desktopSecret !== "string" || !TOKEN_PATTERN.test(desktopSecret)) return null;
  if (typeof value !== "string" || value.length > 256 || !value.startsWith("Basic ")) return null;
  const encoded = value.slice(6);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  let decoded;
  try { decoded = Buffer.from(encoded, "base64").toString("utf8"); } catch { return null; }
  const colon = decoded.indexOf(":");
  if (colon < 1) return null;
  const agentId = decoded.slice(0, colon);
  const token = decoded.slice(colon + 1);
  if (!AGENT_PATTERN.test(agentId) || !TOKEN_PATTERN.test(token)) return null;
  return tokenMatches(token, egressToken(desktopSecret, agentId.toLowerCase())) ? agentId.toLowerCase() : null;
}

function rawResponse(socket, status, reason, headers = "") {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\n${headers}Connection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.setTimeout(2_000, () => socket.destroy());
}

async function resolveChecked(host, resolve) {
  let addresses;
  try { addresses = await resolve(host); } catch { return { error: "upstream_error" }; }
  if (!Array.isArray(addresses) || !addresses.length) return { error: "forbidden_target" };
  if (addresses.some(({ address }) => isBlockedAddress(address))) return { error: "forbidden_target" };
  return { address: addresses[0] };
}

function withTimeout(promise, ms) {
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export function createDesktopProxy({
  desktopSecret, registry, events,
  resolve = (host) => dns.lookup(host, { all: true, verbatim: true }),
  connect = (options) => net.connect(options),
  log = (event) => console.log(JSON.stringify(event)),
} = {}) {
  // TASK-047. Scan before any allow/redirect/refuse decision. The event and log carry no host or canary.
  const scanCanary = (values, source) => {
    for (const value of values) {
      const candidate = findCanary(value);
      if (!candidate) continue;
      const owner = registry.tripByCanary(canaryHash(candidate));
      if (!owner) continue;
      registry.trip(owner);
      events?.push({ agentId: owner, source });
      log({ event: "canary_trip", agent: owner, reason: "canary_leak", source });
      return owner;
    }
    return null;
  };
  const server = createServer((request, response) => {
    const send = (status, headers = {}) => {
      response.writeHead(status, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
      response.end();
    };
    const deny = (agent, host, reason) => log({ event: "egress_blocked", agent, host, reason });
    if (typeof desktopSecret !== "string" || !TOKEN_PATTERN.test(desktopSecret)) return send(403);
    const agent = readBasicAgent(request.headers["proxy-authorization"], desktopSecret);
    if (!agent) return send(407, { "Proxy-Authenticate": 'Basic realm="eclipse-crew"' });
    const entry = registry.get(agent);
    if (!entry) { deny(agent, null, "unknown_agent"); return send(403); }
    if (entry.blocked || entry.tripped) { deny(agent, null, "agent_stopped"); return send(403); }
    const headerValues = Object.values(request.headers).flatMap((value) => Array.isArray(value) ? value : [value])
      .filter((value) => typeof value === "string");
    const leak = scanCanary([request.url ?? "", ...headerValues], "proxy_request");
    if (leak) { deny(leak, null, "canary_leak"); return send(403); }    if (request.method !== "GET" && request.method !== "HEAD") { deny(agent, null, "method_not_allowed"); return send(403); }
    const target = parseHttpTarget(request.url ?? "");
    if (!target) { deny(agent, null, "forbidden_target"); return send(403); }
    if (!registry.allows(agent, target.host)) { deny(agent, target.host, "not_allowed"); return send(403); }
    // Plaintext is never forwarded; the browser retries the same URL over TLS.
    send(307, { Location: `https://${target.host}${target.path}`, Connection: "close" });
  });

  server.on("connect", async (request, clientSocket, head) => {
    clientSocket.on("error", () => clientSocket.destroy());
    const deny = (agent, host, reason) => log({ event: "egress_blocked", agent, host, reason });
    if (typeof desktopSecret !== "string" || !TOKEN_PATTERN.test(desktopSecret)) return rawResponse(clientSocket, 403, "Forbidden");
    const agent = readBasicAgent(request.headers["proxy-authorization"], desktopSecret);
    if (!agent) return rawResponse(clientSocket, 407, "Proxy Authentication Required", 'Proxy-Authenticate: Basic realm="eclipse-crew"\r\n');
    const entry = registry.get(agent);
    if (!entry) { deny(agent, null, "unknown_agent"); return rawResponse(clientSocket, 403, "Forbidden"); }
    if (entry.blocked || entry.tripped) { deny(agent, null, "agent_stopped"); return rawResponse(clientSocket, 403, "Forbidden"); }
    const leak = scanCanary([request.url ?? "", request.headers.host ?? ""], "proxy_host");
    if (leak) { deny(leak, null, "canary_leak"); return rawResponse(clientSocket, 403, "Forbidden"); }
    const host = parseConnectTarget(request.url ?? "");
    if (!host) { deny(agent, null, "forbidden_target"); return rawResponse(clientSocket, 403, "Forbidden"); }
    if (!registry.allows(agent, host)) { deny(agent, host, "not_allowed"); return rawResponse(clientSocket, 403, "Forbidden"); }

    const resolved = await withTimeout(resolveChecked(host, resolve), CONNECT_TIMEOUT_MS);
    if (!resolved || resolved.error) {
      if (!resolved) deny(agent, host, "upstream_timeout");
      else if (resolved.error === "upstream_error") deny(agent, host, "upstream_error");
      else deny(agent, host, "forbidden_target");
      return rawResponse(clientSocket, resolved?.error === "upstream_error" ? 502 : 403, resolved?.error === "upstream_error" ? "Bad Gateway" : "Forbidden");
    }
    if (!registry.addTunnel(agent, clientSocket)) { deny(agent, host, "busy"); return rawResponse(clientSocket, 503, "Service Unavailable"); }

    let upstream;
    try { upstream = connect({ host: resolved.address.address, port: 443, family: resolved.address.family }); }
    catch { registry.removeTunnel(agent, clientSocket); return rawResponse(clientSocket, 502, "Bad Gateway"); }

    let settled = false;
    let connectTimer;
    let lifetimeTimer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(lifetimeTimer);
      try { upstream?.destroy(); } catch { /* already closed */ }
      try { clientSocket.destroy(); } catch { /* already closed */ }
      registry.removeTunnel(agent, clientSocket);
    };
    clientSocket.once("error", finish);
    clientSocket.once("close", finish);
    upstream.once("error", finish);
    upstream.once("close", finish);
    connectTimer = setTimeout(finish, CONNECT_TIMEOUT_MS);
    upstream.once("connect", () => {
      clearTimeout(connectTimer);
      clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: eclipse-crew\r\n\r\n");
      if (head?.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
      clientSocket.setTimeout(IDLE_TIMEOUT_MS, finish);
      upstream.setTimeout(IDLE_TIMEOUT_MS, finish);
      lifetimeTimer = setTimeout(finish, LIFETIME_MS);
      lifetimeTimer.unref?.();
    });
  });

  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    socket.destroy();
  });
  server.headersTimeout = 10_000;
  // The tunnel has its own idle and lifetime timers; do not let the HTTP request timer end it.
  server.requestTimeout = 0;
  server.maxHeaderSize = 16 * 1024;
  return server;
}
