import { Server, request as httpRequest } from "node:http";
import { lookup } from "node:dns/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import WebSocket, { WebSocketServer } from "ws";

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const streamPath = new RegExp(`^/api/desktop/(${uuid})/stream$`, "i");
const authorizationSchema = z.object({
  agentId: z.string().uuid(), ownerId: z.string().uuid(),
  sessionRef: z.string().regex(/^[0-9a-f]{64}$/),
  generation: z.string().uuid(), state: z.literal("running"),
}).strict();
const MAX_FRAME = 8 * 1024 * 1024;
const PROBE_TIMEOUT = 800;

export function canonicalOrigin(value = "http://127.0.0.1:3000") {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.origin !== value || url.username || url.password) throw new Error("invalid_app_origin");
  return url;
}

export function streamTarget(request, origin) {
  if (request.method !== "GET" || request.headers.origin !== origin.origin || request.headers.host?.toLowerCase() !== origin.host.toLowerCase()) throw new Error("origin_denied");
  if (!request.url?.startsWith("/")) throw new Error("invalid_stream");
  const url = new URL(request.url, origin);
  if (url.origin !== origin.origin || request.url !== `${url.pathname}${url.search}`) throw new Error("invalid_stream");
  const match = streamPath.exec(url.pathname);
  const connectionId = url.searchParams.get("connectionId");
  if (!match || url.searchParams.size !== 1 || !z.string().uuid().safeParse(connectionId).success) throw new Error("invalid_stream");
  return { agentId: match[1], connectionId, path: `${url.pathname}${url.search}` };
}

// The only HTTP destination for session validation is this very server's loopback
// listener. Neither the browser URL nor forwarding headers select a destination.
export function probeAuthorization(port, target, cookie, origin) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path: target.path, method: "GET", headers: {
      Host: origin.host, Origin: origin.origin, Cookie: cookie,
      Accept: "application/json",
    } });
    const deadline = setTimeout(() => request.destroy(new Error("authorization_timeout")), PROBE_TIMEOUT);
    request.on("error", reject);
    request.on("close", () => clearTimeout(deadline));
    request.on("response", (response) => {
      const chunks = []; let size = 0;
      response.on("error", reject);
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 4096) { response.destroy(); request.destroy(new Error("authorization_size")); }
        else chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          if (response.statusCode !== 200) throw new Error("authorization_denied");
          const result = authorizationSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          if (result.agentId !== target.agentId) throw new Error("authorization_agent");
          resolve(result);
        } catch { reject(new Error("authorization_denied")); }
      });
    });
    request.end();
  });
}

function securityHeaders(origin) {
  return { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin", "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    ...(origin.protocol === "https:" && process.env.NODE_ENV !== "development" ? { "Strict-Transport-Security": "max-age=31536000" } : {}) };
}

function rejectUpgrade(socket, origin, status = 403) {
  const headers = Object.entries(securityHeaders(origin)).map(([name, value]) => `${name}: ${value}\r\n`).join("");
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${status === 503 ? "Service Unavailable" : "Forbidden"}\r\nConnection: close\r\n${headers}Content-Length: 0\r\n\r\n`);
}

function relay(source, destination, close) {
  source.on("message", (data, binary) => {
    if (!binary || data.length > MAX_FRAME || destination.readyState !== WebSocket.OPEN || destination.bufferedAmount + data.length > MAX_FRAME) return close();
    destination.send(data, { binary: true }, (error) => { if (error) close(); });
  });
  source.on("error", close);
  source.on("close", close);
}

// Next registers its own upgrade listener on the HTTP server on first request.
// Keep Node's upgrade event exclusively owned here so it cannot race this guard.
// This uses Node's public EventEmitter API, not a framework-private upgrade hook.
class DesktopHttpServer extends Server {
  emit(event, ...args) {
    if (event === "upgrade") { void this.desktopUpgrade(...args); return true; }
    return super.emit(event, ...args);
  }
}

export function createAppServer({ handle, origin: originValue = process.env.APP_ORIGIN, secret = process.env.DESKTOP_CONTROL_SECRET, resolveIngress = () => lookup("ingress", { all: true }), connectDesktop } = {}) {
  const origin = canonicalOrigin(originValue);
  const bridge = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false, handleProtocols: (protocols) => protocols.has("binary") ? "binary" : false });
  const connections = new Set();
  let active = 0;
  const server = new DesktopHttpServer(async (request, response) => {
    for (const [name, value] of Object.entries(securityHeaders(origin))) response.setHeader(name, value);
    try {
      // Trust forwarding only from the exact current ingress DNS addresses.
      const peer = request.socket.remoteAddress?.replace(/^::ffff:/, "");
      let deadline;
      const ingress = await Promise.race([resolveIngress().catch(() => []), new Promise((resolve) => { deadline = setTimeout(() => resolve([]), 200); })]).finally(() => clearTimeout(deadline));
      const trusted = ingress.some(({ address }) => address === peer);
      if (!trusted) for (const header of ["x-forwarded-for", "x-real-ip", "x-forwarded-proto", "x-forwarded-host", "forwarded"]) delete request.headers[header];
      if (request.headers.host?.toLowerCase() !== origin.host.toLowerCase()) { response.writeHead(403); response.end(); return; }
      await handle(request, response);
    } catch { if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  // Node's HTTP parser enables upgrades only when a listener is registered;
  // dispatch itself stays exclusively in DesktopHttpServer.emit above.
  server.on("upgrade", () => {});
  server.desktopUpgrade = async (request, socket, head) => {
    socket.on("error", () => {});
    let upstream; let client; let timer; let finished = false;
    let clientAlive = true, upstreamAlive = true;
    if (active >= 64) { rejectUpgrade(socket, origin, 503); return; }
    active++;
    const close = () => {
      if (finished) return;
      finished = true; active--; connections.delete(close); clearTimeout(timer);
      if (client) { client.close(1008, "Desktop stream ended"); const t = setTimeout(() => client.terminate(), 1000); t.unref(); }
      else rejectUpgrade(socket, origin);
      upstream?.terminate();
    };
    connections.add(close);
    socket.once("close", close);
    try {
      const target = streamTarget(request, origin);
      const cookie = request.headers.cookie ?? "";
      if (cookie.length > 16384 || !/^[0-9a-f]{64}$/.test(secret ?? "")) throw new Error("stream_denied");
      const port = server.address()?.port;
      const authorization = await probeAuthorization(port, target, cookie, origin);
      if (finished || socket.destroyed) return close();
      const url = new URL(`/v1/agents/${target.agentId}/stream`, "ws://desktop:4310");
      for (const key of ["ownerId", "sessionRef", "generation"]) url.searchParams.set(key, authorization[key]);
      url.searchParams.set("connectionId", target.connectionId);
      upstream = connectDesktop ? connectDesktop(url, secret) : new WebSocket(url, { headers: { Authorization: `Bearer ${secret}` }, handshakeTimeout: 4000, maxPayload: MAX_FRAME, perMessageDeflate: false });
      await new Promise((resolve, reject) => {
        upstream.once("open", () => { upstream.pause(); resolve(); });
        upstream.once("error", reject);
        upstream.once("close", () => reject(new Error("desktop_closed")));
      });
      if (finished || socket.destroyed) return close();
      bridge.handleUpgrade(request, socket, head, (websocket) => {
        client = websocket;
        client.on("pong", () => { clientAlive = true; });
        upstream.on("pong", () => { upstreamAlive = true; });
        relay(client, upstream, close); relay(upstream, client, close);
        upstream.resume();
        const revalidate = async () => {
          try {
            if (finished || !clientAlive || !upstreamAlive) return close();
            const current = await probeAuthorization(port, target, cookie, origin);
            if (current.ownerId !== authorization.ownerId || current.sessionRef !== authorization.sessionRef || current.generation !== authorization.generation) return close();
            if (client.readyState !== WebSocket.OPEN || upstream.readyState !== WebSocket.OPEN) return close();
            clientAlive = false; upstreamAlive = false;
            client.ping(); upstream.ping();
            if (!finished) timer = setTimeout(revalidate, 3000);
          } catch { close(); }
        };
        timer = setTimeout(revalidate, 3000);
      });
    } catch { close(); }
  };
  server.closeDesktopStreams = () => { for (const close of connections) close(); };
  server.on("close", () => { for (const client of bridge.clients) client.terminate(); bridge.close(); });
  return server;
}

async function main() {
  const args = process.argv.slice(2);
  const dev = args.includes("--dev");
  process.env.NODE_ENV = dev ? "development" : "production";
  const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
  const hostname = option("--hostname", "127.0.0.1");
  const port = Number(option("--port", process.env.PORT ?? "3000"));
  if (!["127.0.0.1", "0.0.0.0"].includes(hostname) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid_listener");
  // Load .env before reading the canonical origin or desktop secret.
  const envModule = await import("@next/env");
  const loadEnvConfig = envModule.loadEnvConfig ?? envModule.default?.loadEnvConfig;
  if (typeof loadEnvConfig !== "function") throw new Error("environment_loader_unavailable");
  loadEnvConfig(process.cwd(), dev);
  const { default: next } = await import("next");
  const app = next({ dev, hostname, port });
  await app.prepare();
  const server = createAppServer({ handle: app.getRequestHandler() });
  server.listen(port, hostname, () => console.log(`Eclipse Crew listening on ${hostname}:${port}`));
  const shutdown = () => { server.closeDesktopStreams(); server.close(); app.close(); };
  process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error("Application startup failed."); process.exitCode = 1; });
