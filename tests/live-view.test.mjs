import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, request } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { createAppServer, canonicalOrigin, streamTarget } from "../scripts/app-server.mjs";
import { wsVncPorts } from "../docker/desktop/vnc-session.mjs";

const agentId = randomUUID(), ownerId = randomUUID(), connectionId = randomUUID();
const secret = "b".repeat(64), sessionRef = "c".repeat(64);
const path = `/api/desktop/${agentId}/stream?connectionId=${connectionId}`;

test("VNC ports are distinct and reject invalid uid", () => {
  assert.deepEqual(wsVncPorts(20000), { vncPort: 5950 });
  assert.notDeepEqual(wsVncPorts(20001), wsVncPorts(20002));
  for (const uid of [19999, 60000, NaN]) assert.throws(() => wsVncPorts(uid), /vnc_uid_invalid/);
});

test("stream origin and target reject mismatched scheme/port/host and arbitrary queries", () => {
  const origin = canonicalOrigin();
  const req = { method: "GET", url: path, headers: { origin: origin.origin, host: origin.host } };
  assert.equal(streamTarget(req, origin).connectionId, connectionId);
  for (const value of ["https://127.0.0.1:3000", "http://127.0.0.1:3001", "null", "http://127.0.0.1:3000/"]) assert.throws(() => streamTarget({ ...req, headers: { ...req.headers, origin: value } }, origin));
  for (const url of ["/api/desktop/wrong/stream", `${path}&url=http://evil`, `${path}&connectionId=${connectionId}`, `http://evil${path}`, `//evil${path}`, `/ignored/..${path}`, `${path}#fragment`, "/_next/webpack-hmr"]) assert.throws(() => streamTarget({ ...req, url }, origin));
  assert.throws(() => streamTarget({ ...req, headers: { ...req.headers, host: "evil:3000" } }, origin));
  for (const value of ["file:///x", "http://user@127.0.0.1:3000", "http://127.0.0.1:3000/"]) assert.throws(() => canonicalOrigin(value));
});

async function fixture(t, { upstreamAutoPong = true, origin: originValue = "http://127.0.0.1:3000" } = {}) {
  const origin = new URL(originValue);
  const desktop = createServer();
  const wss = new WebSocketServer({ server: desktop, autoPong: upstreamAutoPong });
  const seen = []; const peers = new Set();
  wss.on("connection", (ws) => {
    peers.add(ws); ws.on("close", () => peers.delete(ws));
    ws.send(Buffer.from("RFB 003.008\n"));
    ws.on("message", (data, binary) => ws.send(data, { binary }));
  });
  desktop.listen(0, "127.0.0.1"); await once(desktop, "listening");
  let valid = true, generation = randomUUID(), spoofed;
  let graphics = "running", browser = "running", rawResponse = null;
  const server = createAppServer({
    origin: originValue, secret, resolveIngress: async () => [],
    handle: async (req, res) => {
      if (req.url === "/failure") throw new Error("synthetic handler failure");
      if (req.url === "/headers") { spoofed = req.headers; res.end("ok"); return; }
      if (!valid || req.headers.cookie !== "session=valid") { res.writeHead(401); res.end(); return; }
      assert.equal(req.headers.host, origin.host);
      assert.equal(req.headers.origin, origin.origin);
      res.setHeader("Content-Type", "application/json");
      if (rawResponse !== null) { res.end(JSON.stringify(rawResponse)); return; }
      res.end(JSON.stringify({ agentId, ownerId, sessionRef, generation, state: "running", graphics, browser }));
    },
    connectDesktop(url, key) {
      seen.push({ url, key });
      return new WebSocket(`ws://127.0.0.1:${desktop.address().port}`);
    },
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const clients = [];
  t.after(async () => {
    for (const ws of clients) ws.terminate();
    for (const ws of peers) ws.terminate();
    server.closeAllConnections(); desktop.closeAllConnections();
    await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => desktop.close(resolve))]);
    wss.close();
  });
  return { seen, server, peers, revoke: () => { valid = false; }, replace: () => { generation = randomUUID(); },
    setGraphics: (value) => { graphics = value; }, setBrowser: (value) => { browser = value; },
    setRawResponse: (value) => { rawResponse = value; }, getSpoofed: () => spoofed,
    ws(headers = {}, url = path, options = {}) {
      const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}${url}`, { ...options, headers: { Host: origin.host, Origin: origin.origin, Cookie: "session=valid", ...headers } });
      clients.push(ws); return ws;
    },
  };
}

async function denied(ws) {
  return new Promise((resolve, reject) => {
    ws.on("open", () => reject(new Error("unexpected_upgrade")));
    ws.on("unexpected-response", (_req, res) => { assert.equal(res.statusCode, 403); res.resume(); ws.terminate(); resolve(); });
    ws.on("error", () => {});
  });
}

test("HTTP strips spoofed forwarding headers when peer is not configured ingress", async (t) => {
  const f = await fixture(t);
  await new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: f.server.address().port, path: "/headers", headers: { Host: "127.0.0.1:3000", "X-Forwarded-For": "1.2.3.4", "X-Real-IP": "1.2.3.4", "X-Forwarded-Proto": "https", "Forwarded": "for=evil" } }, (res) => { res.resume(); res.on("end", resolve); });
    req.on("error", reject); req.end();
  });
  assert.equal(f.getSpoofed()["x-forwarded-for"], undefined);
  assert.equal(f.getSpoofed()["x-real-ip"], undefined);
  assert.equal(f.getSpoofed()["x-forwarded-proto"], undefined);
  assert.equal(f.getSpoofed().forwarded, undefined);
});

test("native upgrade refuses forged sessions, cross origin, arbitrary paths and host spoofing", async (t) => {
  const f = await fixture(t);
  let otherListenerCalled = false;
  // Next's ordinary HTTP handler adds its own listener lazily. It must never
  // receive upgrades, including those our owner authentication has rejected.
  f.server.on("upgrade", () => { otherListenerCalled = true; });
  await denied(f.ws({ Cookie: "session=fabricated" }));
  await denied(f.ws({ Cookie: "" }));
  await denied(f.ws({ Origin: "https://127.0.0.1:3000" }));
  await denied(f.ws({ Host: "evil:3000" }));
  await denied(f.ws({}, "/_next/webpack-hmr"));
  await denied(f.ws({}, `${path}&target=evil`));
  assert.equal(f.seen.length, 0);
  assert.equal(otherListenerCalled, false);
});

test("authorized upgrade relays real binary frames with server-only controller scope", async (t) => {
  const f = await fixture(t); const ws = f.ws();
  const first = once(ws, "message"); await once(ws, "open");
  const [rfb, binary] = await first;
  assert.equal(binary, true); assert.equal(rfb.toString(), "RFB 003.008\n");
  const next = once(ws, "message"); ws.send(Buffer.from([1, 2, 3]));
  assert.deepEqual((await next)[0], Buffer.from([1, 2, 3]));
  assert.equal(f.seen[0].key, secret);
  const url = f.seen[0].url;
  assert.equal(url.origin, "ws://desktop:4310");
  assert.equal(url.pathname, `/v1/agents/${agentId}/stream`);
  assert.equal(url.searchParams.get("ownerId"), ownerId);
  assert.equal(url.searchParams.get("sessionRef"), sessionRef);
  assert.equal(url.searchParams.get("connectionId"), connectionId);
});

test("browser-only stop keeps the desktop stream viewable", async (t) => {
  const f = await fixture(t);
  f.setBrowser("stopped");
  const ws = f.ws();
  const opened = once(ws, "open");
  const first = once(ws, "message");
  await opened;
  const [rfb, binary] = await first;
  assert.equal(binary, true); assert.equal(rfb.toString(), "RFB 003.008\n");
});

test("nonstreamable graphics states deny the upgrade", async (t) => {
  for (const graphics of ["stopped", "failed", "starting"]) {
    const f = await fixture(t);
    f.setGraphics(graphics);
    await denied(f.ws());
    assert.equal(f.seen.length, 0, graphics);
  }
});

test("legacy five-field authorization without graphics/browser is denied", async (t) => {
  const f = await fixture(t);
  // Well-formed legacy shape explicitly (no graphics/browser) must no longer pass.
  f.setRawResponse({ agentId, ownerId, sessionRef, generation: "11111111-1111-4111-8111-111111111111", state: "running" });
  await denied(f.ws());
  assert.equal(f.seen.length, 0);
});

test("malformed, unauthorized and nonstreamable stream authorizations are denied", async (t) => {
  const f = await fixture(t);
  const good = { agentId, ownerId, sessionRef, generation: "11111111-1111-4111-8111-111111111111", state: "running", graphics: "running", browser: "running" };
  const badResponses = [
    { ...good, graphics: "stopped" },
    { ...good, browser: "bogus" },
    { ...good, state: "stopped" },
    { ...good, generation: "not-a-uuid" },
    { ...good, extra: true },
    { agentId, ownerId, sessionRef, generation: good.generation, state: "running", graphics: "running" },
  ];
  for (const response of badResponses) {
    f.setRawResponse(response);
    await denied(f.ws());
  }
  assert.equal(f.seen.length, 0);
  f.setRawResponse(null);
  f.setGraphics("stopped");
  const ws = f.ws(); await new Promise((resolve, reject) => {
    ws.on("open", () => reject(new Error("unexpected_upgrade")));
    ws.on("unexpected-response", (_req, res) => { assert.equal(res.statusCode, 403); res.resume(); ws.terminate(); resolve(); });
    ws.on("error", () => {});
  });
});

test("revalidation closes the stream after graphics stops mid-session", { timeout: 7000 }, async (t) => {
  const f = await fixture(t); const ws = f.ws(); await once(ws, "open");
  const closed = once(ws, "close");
  f.setGraphics("stopped");
  assert.equal((await closed)[0], 1008);
});

test("native bridge preserves an RFB greeting coalesced with the upstream upgrade", { timeout: 5000 }, async (t) => {
  const sockets = new Set();
  const desktop = createServer();
  desktop.on("upgrade", (req, socket) => {
    sockets.add(socket); socket.on("error", () => {});
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    const headers = Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(Buffer.concat([headers, Buffer.from([0x82, 12]), Buffer.from("RFB 003.008\n")]));
  });
  desktop.listen(0, "127.0.0.1"); await once(desktop, "listening");
  const server = createAppServer({ origin: "http://127.0.0.1:3000", secret, resolveIngress: async () => [],
    handle: (_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ agentId, ownerId, sessionRef, generation: randomUUID(), state: "running", graphics: "running", browser: "running" })); },
    connectDesktop: () => new WebSocket(`ws://127.0.0.1:${desktop.address().port}`),
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}${path}`, { headers: { Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3000", Cookie: "session=valid" } });
  t.after(async () => { client.terminate(); server.closeDesktopStreams(); for (const socket of sockets) socket.destroy(); await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => desktop.close(resolve))]); });
  const [message, binary] = await once(client, "message");
  assert.equal(binary, true); assert.equal(message.toString(), "RFB 003.008\n");
});

for (const change of ["revoke", "replace"]) test(`native upgrade closes stream within five seconds after ${change}`, { timeout: 7000 }, async (t) => {
  const f = await fixture(t); const ws = f.ws(); await once(ws, "open");
  const closed = once(ws, "close"); const start = Date.now(); f[change]();
  assert.equal((await closed)[0], 1008); assert.ok(Date.now() - start < 5000);
});

test("native bridge rejects text frames on binary RFB channel", async (t) => {
  const f = await fixture(t); const ws = f.ws(); await once(ws, "open");
  const closed = once(ws, "close"); ws.send("not-rfb"); assert.equal((await closed)[0], 1008);
});

for (const side of ["browser", "desktop"]) test(`native bridge releases a silent ${side} connection on the next heartbeat cycle`, { timeout: 9000 }, async (t) => {
  const f = await fixture(t, { upstreamAutoPong: side !== "desktop" });
  const ws = f.ws({}, path, { autoPong: side !== "browser" }); await once(ws, "open");
  const upstreamClosed = once([...f.peers][0], "close");
  const start = Date.now();
  assert.equal((await once(ws, "close"))[0], 1008);
  await upstreamClosed;
  assert.ok(Date.now() - start < 8000, "silent streams must release without an OS TCP timeout");
});

test("browser disconnect and application shutdown close the controller stream", async (t) => {
  const f = await fixture(t); const ws = f.ws(); await once(ws, "open");
  const closed = once([...f.peers][0], "close"); ws.terminate(); await closed;
  const next = f.ws(); await once(next, "open");
  const controllerClosed = once([...f.peers][0], "close"); const browserClosed = once(next, "close");
  f.server.closeDesktopStreams(); await controllerClosed; assert.equal((await browserClosed)[0], 1008);
});

test("native HTTP and upgrade errors retain CSP, no-store, nosniff and configured HTTPS HSTS", async (t) => {
  const f = await fixture(t, { origin: "https://127.0.0.1:3000" });
  const get = (path, host) => new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: f.server.address().port, path, headers: { Host: host } }, (response) => { response.resume(); response.on("end", () => resolve(response)); });
    req.on("error", reject); req.end();
  });
  for (const [path, host, expected] of [["/", "evil.test", 403], ["/failure", "127.0.0.1:3000", 500]]) {
    const response = await get(path, host);
    assert.equal(response.statusCode, expected);
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.headers["strict-transport-security"], "max-age=31536000");
    assert.match(response.headers["cache-control"], /no-store/);
    assert.match(response.headers["content-security-policy"], /frame-ancestors 'none'/);
  }
  const ws = f.ws({ Cookie: "fabricated" });
  await new Promise((resolve, reject) => {
    ws.on("open", () => reject(new Error("unexpected_upgrade")));
    ws.on("unexpected-response", (_req, response) => {
      assert.equal(response.statusCode, 403);
      assert.equal(response.headers["x-content-type-options"], "nosniff");
      assert.equal(response.headers["strict-transport-security"], "max-age=31536000");
      assert.match(response.headers["content-security-policy"], /default-src 'none'/);
      response.resume(); ws.terminate(); resolve();
    });
    ws.on("error", () => {});
  });
});
