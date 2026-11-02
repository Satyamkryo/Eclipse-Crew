import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";

import { isBlockedAddress } from "./addresses.mjs";
import { canaryHash, findCanary } from "./canary.mjs";
import { egressToken, tokenMatches } from "./registry.mjs";

// TASK-073b. Git smart-HTTP gateway. The relay authenticates the agent with a preface line, never the
// agent's headers; the gateway reads receive-pack ref commands before forwarding, injects the Basic
// credential here (the only place that can read the request), and refuses default-branch pushes and
// remote deletes with 403 until the owner grants them in TASK-073c.

export const HOST = "github.com";
export const MAX_BODY = 512 * 1024 * 1024;
export const MAX_HEAD = 16 * 1024;
export const MAX_PREFIX = 64 * 1024;
export const MAX_PER_AGENT = 4;
export const MAX_TOTAL = 16;
export const REQUEST_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_BRANCH_TTL_MS = 5 * 60_000;
const PREFACE_LIMIT = 256;
const PREFACE_TIMEOUT_MS = 2_000;
const AGENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPO_PART = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const GATEWAY_PATH = /^\/git\/github\.com\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const GIT_SERVICE = /^git-(upload|receive)-pack$/;
const HASH = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const REF = /^refs\/(heads|tags)\/[^\s\0]{1,255}$/;
const RESPONSE_HEADERS = { "content-type": "Content-Type", "content-length": "Content-Length", "cache-control": "Cache-Control",
  etag: "ETag", vary: "Vary", "www-authenticate": "WWW-Authenticate", "retry-after": "Retry-After" };

export function validatePreface(line, desktopSecret) {
  if (typeof desktopSecret !== "string" || !/^[0-9a-f]{64}$/.test(desktopSecret)) return null;
  const text = typeof line === "string" ? line.replace(/\r?\n$/, "") : "";
  const match = /^ECLIPSE-AGENT ([0-9a-f-]{36}) ([0-9a-f]{64})$/.exec(text);
  if (!match || !AGENT.test(match[1])) return null;
  const agentId = match[1].toLowerCase();
  return tokenMatches(match[2], egressToken(desktopSecret, agentId)) ? agentId : null;
}

export function parseGatewayPath(value) {
  let url;
  try { url = new URL(value, "http://gateway.local"); } catch { return null; }
  if (url.username || url.password || url.hash) return null;
  const match = GATEWAY_PATH.exec(url.pathname);
  if (!match || !REPO_PART.test(match[1]) || !REPO_PART.test(match[2])) return null;
  const [, owner, repo, action] = match;
  const services = url.searchParams.getAll("service");
  if (action === "info/refs") {
    if (services.length !== 1 || !GIT_SERVICE.test(services[0]) || [...url.searchParams.keys()].length !== 1) return null;
    return { action, owner, repo, method: "GET", service: services[0],
      upstream: `/${owner}/${repo}.git/info/refs?service=${services[0]}` };
  }
  if (url.search || services.length) return null;
  return { action, owner, repo, method: "POST", service: action, upstream: `/${owner}/${repo}.git/${action}` };
}

// pkt-line: four hex digits including the length; 0000 is the command-list flush.
export function parsePktLines(buffer) {
  const commands = []; let offset = 0; let capabilities = ""; let first = true;
  while (true) {
    if (offset + 4 > buffer.length) return { complete: false, commands, capabilities, offset };
    const text = buffer.toString("ascii", offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(text)) return { error: "invalid_pkt_line", commands, capabilities, offset };
    const length = parseInt(text, 16);
    if (length === 0) return { complete: true, commands, capabilities, offset: offset + 4 };
    if (length < 4 || length > MAX_PREFIX || offset + length > MAX_PREFIX) return { error: "pkt_line_too_large", commands, capabilities, offset };
    if (offset + length > buffer.length) return { complete: false, commands, capabilities, offset };
    const payload = buffer.toString("utf8", offset + 4, offset + length).replace(/\n$/, "");
    if (first) {
      if (payload.startsWith("push-cert")) return { error: "push_cert_refused", commands, capabilities, offset };
      const nul = payload.indexOf("\0");
      capabilities = nul < 0 ? "" : payload.slice(nul + 1);
      first = false;
      const command = nul < 0 ? payload : payload.slice(0, nul);
      const parsed = parseCommand(command);
      if (parsed.error) return { ...parsed, commands, capabilities, offset };
      commands.push(parsed.command);
    } else {
      const parsed = parseCommand(payload);
      if (parsed.error) return { ...parsed, commands, capabilities, offset };
      commands.push(parsed.command);
    }
    offset += length;
  }
}
function parseCommand(value) {
  const parts = value.split(" ");
  if (parts.length !== 3 || !HASH.test(parts[0]) || !HASH.test(parts[1]) || !REF.test(parts[2])) return { error: "invalid_push_command" };
  return { command: { old: parts[0], new: parts[1], ref: parts[2] } };
}

const zero = (value) => /^0+$/.test(value);
export function classifyPush(commands, defaultBranch) {
  const blocked = [];
  for (const command of commands) {
    const deleted = zero(command.new);
    if (command.ref.startsWith("refs/tags/")) {
      if (deleted) blocked.push({ kind: "delete", class: "delete", ref: command.ref, name: command.ref.slice(10) });
      else if (!zero(command.old)) blocked.push({ kind: "tag_update", class: "delete", ref: command.ref, name: command.ref.slice(10) });
      continue;
    }
    const branch = command.ref.slice(11);
    if (deleted) { blocked.push({ kind: "delete", class: "delete", ref: command.ref, name: branch }); continue; }
    if (defaultBranch ? branch === defaultBranch : !zero(command.old)) {
      blocked.push({ kind: "default_branch", class: "post", ref: command.ref, name: branch });
    }
  }
  return { allowed: blocked.length === 0, blocked };
}

function reasonText(decision) {
  const item = decision.blocked[0];
  if (!item) return "push refused";
  if (item.kind === "default_branch") return `push to ${item.name} needs the owner in chat`;
  if (item.kind === "delete") return `deleting ${item.name} needs the owner in chat`;
  return `moving tag ${item.name} needs the owner in chat`;
}

function writeHead(socket, status, message, headers) {
  const lines = [`HTTP/1.1 ${status} ${message}`];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  lines.push("Connection: close", "", "");
  socket.write(lines.join("\r\n"));
}
function respondJson(socket, status, code, extra = {}) {
  const body = Buffer.from(JSON.stringify({ error: code, ...extra }));
  writeHead(socket, status, status === 403 ? "Forbidden" : status === 413 ? "Payload Too Large" : status === 400 ? "Bad Request" : "Error",
    { "Content-Type": "application/json", "Content-Length": String(body.length), "Cache-Control": "no-store" });
  socket.end(body);
}
function sanitize(value) {
  return typeof value === "string" && /^[\x20-\x7e]{1,1024}$/.test(value);
}

export function createGitGateway({
  desktopSecret, registry, credentials, events = null,
  resolve = (host) => dns.lookup(host, { all: true, verbatim: true }),
  upstream = https.request, lookupDefaultBranch = null, now = Date.now, log = () => {},
} = {}) {
  if (typeof desktopSecret !== "string" || !/^[0-9a-f]{64}$/.test(desktopSecret)) throw Error("invalid_gateway_secret");
  const branches = new Map(); const active = new Map(); let total = 0;

  async function defaultBranchFor(agentId, owner, repo) {
    if (lookupDefaultBranch) return lookupDefaultBranch(agentId, owner, repo);
    const key = `${owner}/${repo}`; const cached = branches.get(key);
    if (cached && cached.expiresAt > now()) return cached.value;
    const credential = credentials?.lookup(agentId, "api.github.com") ?? credentials?.lookup(agentId, HOST);
    if (!credential || !["basic", "bearer"].includes(credential.scheme) || (!credential.token && !credential.username)) return null;
    const authorization = credential.scheme === "bearer"
      ? `Bearer ${credential.token}`
      : `Basic ${Buffer.from(`${credential.username}:${credential.token}`).toString("base64")}`;
    const value = await new Promise((done) => {
      let address;
      resolve("api.github.com").then((addresses) => {
        if (!Array.isArray(addresses) || !addresses.length || addresses.some(({ address }) => isBlockedAddress(address))) return done(null);
        address = addresses[0];
        const request = https.request({ host: "api.github.com", port: 443, method: "GET", path: `/repos/${owner}/${repo}`, servername: "api.github.com",
          headers: { authorization, accept: "application/vnd.github+json", "user-agent": "eclipse-crew-egress/1", "accept-encoding": "identity" },
          autoSelectFamily: false, timeout: 5000, lookup: (_name, options, callback) => options?.all ? callback(null, [address]) : callback(null, address.address, address.family) },
        (response) => {
          const chunks = []; let size = 0;
          response.on("data", (chunk) => { size += chunk.length; if (size > 65536) { response.destroy(); return; } chunks.push(chunk); });
          response.on("end", () => {
            if (response.statusCode !== 200) return done(null);
            try { const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              done(typeof body.default_branch === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(body.default_branch) ? body.default_branch : null);
            } catch { done(null); }
          });
          response.on("error", () => done(null));
        });
        request.on("error", () => done(null)); request.on("timeout", () => { request.destroy(); done(null); }); request.end();
      }).catch(() => done(null));
    });
    branches.set(key, { value, expiresAt: now() + DEFAULT_BRANCH_TTL_MS });
    return value;
  }

  async function handleRequest(socket, agentId, method, requestPath, headers) {
    const route = parseGatewayPath(requestPath);
    if (!route || route.method !== method) return respondJson(socket, 404, "not_found");
    for (const value of [requestPath, route.owner, route.repo]) {
      const candidate = findCanary(value); if (!candidate) continue;
      const owner = registry?.tripByCanary(canaryHash(candidate)); if (!owner) continue;
      registry.trip(owner); events?.push({ agentId: owner, source: "git_gateway" });
      log({ event: "canary_trip", agent: owner, reason: "canary_leak", source: "git_gateway" });
      return respondJson(socket, 403, "canary_blocked");
    }
    const policy = registry?.get(agentId);
    if (!policy || policy.blocked || policy.tripped || !registry.allows(agentId, HOST)) return respondJson(socket, 403, "agent_unavailable");
    const credential = credentials?.lookup(agentId, HOST);
    if (!credential || credential.scheme !== "basic" || !credential.username) return respondJson(socket, 403, "credential_required");
    if (total >= MAX_TOTAL || (active.get(agentId) ?? 0) >= MAX_PER_AGENT) return respondJson(socket, 503, "busy");
    if (headers["content-encoding"] && headers["content-encoding"] !== "identity") return respondJson(socket, 415, "encoding_refused");

    const authorization = `Basic ${Buffer.from(`${credential.username}:${credential.token}`, "utf8").toString("base64")}`;
    const outgoing = { host: HOST, "user-agent": "eclipse-crew-egress/1", accept: "*/*", "accept-encoding": "identity", authorization };
    for (const name of ["content-type", "git-protocol"]) {
      const value = headers[name]; if (value !== undefined) { if (!sanitize(value)) return respondJson(socket, 400, "invalid_request"); outgoing[name] = value; }
    }
    const address = await new Promise((done) => resolve(HOST).then((addresses) =>
      done(Array.isArray(addresses) && addresses.length && !addresses.some(({ address }) => isBlockedAddress(address)) ? addresses[0] : null)).catch(() => done(null)));
    if (socket.destroyed) return;
    if (!address) return respondJson(socket, 403, "forbidden_target");

    active.set(agentId, (active.get(agentId) ?? 0) + 1); total += 1;
    let released = false;
    const release = () => { if (released) return; released = true; total -= 1; const count = (active.get(agentId) ?? 1) - 1; if (count > 0) active.set(agentId, count); else active.delete(agentId); };
    socket.once("close", release);

    let upstreamRequest;
    const writeUpstream = (chunk) => {
      if (!upstreamRequest.write(chunk)) {
        socket.pause();
        upstreamRequest.once("drain", () => { if (!socket.destroyed) socket.resume(); });
      }
    };
    const start = (bodyHeaders) => {
      upstreamRequest = upstream({ host: HOST, port: 443, method, path: route.upstream, headers: bodyHeaders, servername: HOST,
        autoSelectFamily: false, timeout: REQUEST_TIMEOUT_MS,
        lookup: (_name, options, callback) => options?.all ? callback(null, [address]) : callback(null, address.address, address.family) },
      (response) => {
        const responseHeaders = { "Cache-Control": "no-store" };
        for (const [name, header] of Object.entries(RESPONSE_HEADERS)) {
          const value = response.headers[name];
          if (typeof value === "string" && sanitize(value)) responseHeaders[header] = value;
        }
        writeHead(socket, response.statusCode ?? 502, sanitize(response.statusMessage) ? response.statusMessage : "Upstream", responseHeaders);
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY) { response.destroy(); socket.destroy(); return; }
          if (!socket.write(chunk)) {
            response.pause();
            socket.once("drain", () => response.resume());
          }
        });
        response.on("end", () => socket.end());
        response.on("error", () => socket.destroy());
      });
      upstreamRequest.on("error", () => { if (!socket.destroyed) respondJson(socket, 502, "upstream_error"); });
      upstreamRequest.on("timeout", () => { upstreamRequest.destroy(); if (!socket.destroyed) respondJson(socket, 504, "upstream_timeout"); });
    };

    if (method === "GET") { start(outgoing); upstreamRequest.end(); return { stage: "done" }; }
    if (headers["transfer-encoding"] !== undefined) return respondJson(socket, 411, "length_required");
    const length = Number(headers["content-length"]);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY) return respondJson(socket, 411, "length_required");
    outgoing["content-length"] = String(length);
    let received = 0;

    if (route.action === "git-upload-pack") {
      start(outgoing);
      return { stage: "body", feed: (chunk) => {
        received += chunk.length;
        if (received > length) return { error: [413, "body_too_large"] };
        writeUpstream(chunk);
        if (received === length) upstreamRequest.end();
        return null;
      } };
    }

    // receive-pack: read the pkt-line command list (at most 64 KiB) before forwarding any pack bytes.
    let prefix = Buffer.alloc(0); let decided = false;
    return { stage: "body", feed: (chunk) => {
      received += chunk.length;
      if (received > length) return { error: [413, "body_too_large"] };
      if (decided) {
        writeUpstream(chunk);
        if (received === length) upstreamRequest.end();
        return null;
      }
      prefix = Buffer.concat([prefix, chunk]);
      const parsed = parsePktLines(prefix);
      if (parsed.error) return { error: [400, parsed.error] };
      if (!parsed.complete) {
        if (prefix.length >= MAX_PREFIX) return { error: [400, "push_commands_too_large"] };
        if (received === length) return { error: [400, "truncated_push"] };
        return null;
      }
      decided = true;
      return { pending: (async () => {
        const defaultBranch = await defaultBranchFor(agentId, route.owner, route.repo);
        const decision = classifyPush(parsed.commands, defaultBranch);
        if (!decision.allowed) {
          log({ event: "git_push_blocked", agent: agentId, host: HOST, decision: decision.blocked[0].kind });
          return { blocked: reasonText(decision) };
        }
        start(outgoing); writeUpstream(prefix);
        if (received === length) upstreamRequest.end();
        return null;
      })() };
    } };
  }

  const server = net.createServer((socket) => {
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
    let buffer = Buffer.alloc(0); let stage = "preface"; let handler = null; let agentId = null; let pumping = false; let again = false;
    const prefaceTimer = setTimeout(() => { if (stage === "preface") socket.destroy(); }, PREFACE_TIMEOUT_MS);
    const pump = async () => {
      if (pumping) { again = true; return; }
      pumping = true;
      try {
        do {
          again = false;
          if (stage === "preface") {
            const end = buffer.indexOf("\n");
            if (end < 0) { if (buffer.length > PREFACE_LIMIT) socket.destroy(); continue; }
            agentId = validatePreface(buffer.subarray(0, end + 1).toString("latin1"), desktopSecret);
            if (!agentId) { respondJson(socket, 403, "preface_denied"); break; }
            clearTimeout(prefaceTimer); buffer = buffer.subarray(end + 1); stage = "head";
          } else if (stage === "head") {
            const end = buffer.indexOf("\r\n\r\n");
            if (end < 0) { if (buffer.length > MAX_HEAD) { respondJson(socket, 431, "headers_too_large"); break; } continue; }
            const lines = buffer.subarray(0, end).toString("latin1").split("\r\n");
            buffer = buffer.subarray(end + 4);
            const requestLine = /^(GET|POST) (\S{1,2048}) HTTP\/1\.1$/.exec(lines.shift() ?? "");
            if (!requestLine) { respondJson(socket, 400, "invalid_request"); break; }
            const headers = {};
            let invalid = false;
            for (const line of lines) {
              if (lines.length > 100) { invalid = true; break; }
              const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}):[ \t]*(.*)$/.exec(line);
              if (!match) { invalid = true; break; }
              headers[match[1].toLowerCase()] = match[2];
            }
            if (invalid) { respondJson(socket, 400, "invalid_request"); break; }
            if (headers.expect?.toLowerCase() === "100-continue") socket.write("HTTP/1.1 100 Continue\r\n\r\n");
            handler = await handleRequest(socket, agentId, requestLine[1], requestLine[2], headers);
            if (!handler) break;
            stage = handler.stage;
          } else if (stage === "body") {
            if (!buffer.length) continue;
            const chunk = buffer; buffer = Buffer.alloc(0);
            const value = handler.feed(chunk);
            if (value?.error) { respondJson(socket, value.error[0], value.error[1]); socket.destroy(); break; }
            if (value?.pending) {
              const result = await value.pending;
              if (result?.error) { respondJson(socket, result.error[0], result.error[1]); socket.destroy(); break; }
              if (result?.blocked) { respondJson(socket, 403, "push_refused", { detail: result.blocked }); socket.destroy(); break; }
              if (handler.stage === "done") break;
            }
          } else break;
        } while (again || (stage === "head" && buffer.length) || (stage === "body" && buffer.length));
      } finally { pumping = false; }
    };
    socket.on("data", (chunk) => { buffer = Buffer.concat([buffer, chunk]); void pump().catch((error) => { log({ event: "gateway_error", code: /^[a-z_]{1,64}$/.test(error?.code ?? "") ? error.code : "internal" }); socket.destroy(); }); });
    socket.on("error", () => socket.destroy());
  });
  server.maxConnections = MAX_TOTAL;
  return {
    listen: (port, host = "0.0.0.0") => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => resolve(server.address())); }),
    close: () => new Promise((resolve) => { server.close(() => resolve()); setTimeout(() => resolve(), 1000).unref?.(); }),
    stats: () => ({ active: total, branches: branches.size }),
  };
}
