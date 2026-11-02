import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { canaryHash, findCanary } from "../docker/egress/canary.mjs";
import { createDesktopProxy } from "../docker/egress/desktop-proxy.mjs";
import { createEventLog } from "../docker/egress/events.mjs";
import { createProxy, validatePolicy } from "../docker/egress/proxy.mjs";
import { createRegistry, egressToken } from "../docker/egress/registry.mjs";

const PROXY_SECRET = "ab".repeat(32);
const DESKTOP_SECRET = "cd".repeat(32);
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PEER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CANARY = `ecx-${"a".repeat(32)}`;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}
function close(server) {
  return new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
}
function rawRequest(port, lines) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let data = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("timeout")); }, 5_000);
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.on("data", (chunk) => {
      data += chunk.toString("latin1");
      if (!data.includes("\r\n\r\n")) return;
      clearTimeout(timer);
      socket.removeAllListeners("data");
      resolve({ socket, head: data });
    });
    socket.once("connect", () => socket.write(`${lines.join("\r\n")}\r\n\r\n`));
  });
}
function authLine(agent = AGENT) {
  return `Proxy-Authorization: Basic ${Buffer.from(`${agent}:${egressToken(DESKTOP_SECRET, agent)}`).toString("base64")}`;
}

test("the proxy can reform the canary from a percent-encoded host or header", () => {
  assert.equal(findCanary(`https://${CANARY}.evil.test/`), CANARY);
  assert.equal(findCanary(`ecx-%61${"a".repeat(31)}`), CANARY);
  assert.equal(findCanary("nothing"), null);
});

test("the event ring keeps the newest events and a stable boot id", () => {
  const log = createEventLog({ max: 2 });
  log.push({ agentId: AGENT, source: "proxy_host" });
  log.push({ agentId: PEER, source: "proxy_request" });
  log.push({ agentId: AGENT, source: "proxy_host" });
  assert.equal(typeof log.boot, "string");
  assert.equal(log.after(0).length, 2);
  assert.deepEqual(log.after(1).map((event) => event.seq), [2, 3]);
  assert.equal(JSON.stringify(log.all()).includes(CANARY), false);
});

test("a canary hash trips only its owner and survives policy refreshes until clearTrip", () => {
  const registry = createRegistry();
  const hash = canaryHash(CANARY);
  registry.setPolicy(AGENT, ["example.com"], false, { canaryHashes: [hash] });
  registry.setPolicy(PEER, ["example.com"], false, { canaryHashes: [canaryHash(`ecx-${"b".repeat(32)}`)] });
  assert.equal(registry.tripByCanary(hash), AGENT);
  assert.equal(registry.tripByCanary(canaryHash(`ecx-${"c".repeat(32)}`)), null);
  registry.trip(AGENT);
  assert.equal(registry.get(AGENT).tripped, true);
  assert.equal(registry.get(PEER).tripped, false);
  assert.equal(registry.allows(AGENT, "example.com"), false);
  assert.equal(registry.allows(PEER, "example.com"), true);
  registry.setPolicy(AGENT, ["example.com"], false, { canaryHashes: [hash] });
  assert.equal(registry.get(AGENT).tripped, true, "a normal refresh does not clear a trip");
  registry.setPolicy(AGENT, ["example.com"], false, { canaryHashes: [hash], clearTrip: true });
  assert.equal(registry.get(AGENT).tripped, false);
  assert.equal(registry.allows(AGENT, "example.com"), true);
});

test("policy validation accepts canary hashes and trip flags and rejects malformed ones", () => {
  const hash = canaryHash(CANARY);
  assert.deepEqual(validatePolicy({ agentId: AGENT, domains: ["example.com"], blocked: false, canaryHashes: [hash], trip: true }),
    { agentId: AGENT, domains: ["example.com"], blocked: false, canaryHashes: [hash], trip: true, clearTrip: false });
  assert.throws(() => validatePolicy({ agentId: AGENT, domains: [], blocked: false, canaryHashes: ["nope"] }));
  assert.throws(() => validatePolicy({ agentId: AGENT, domains: [], blocked: false, trip: true, clearTrip: true }));
  assert.throws(() => validatePolicy({ agentId: AGENT, domains: [], blocked: false, trash: true }));
});

test("the app events endpoint is authenticated and bounded", async () => {
  const events = createEventLog();
  events.push({ agentId: AGENT, source: "proxy_host" });
  const server = createProxy({ secret: PROXY_SECRET, registry: createRegistry(), events });
  const port = await listen(server);
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/events?after=0`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/events?after=x`, {
      headers: { Authorization: `Bearer ${PROXY_SECRET}` },
    })).status, 400);
    const response = await fetch(`http://127.0.0.1:${port}/v1/events?after=0`, {
      headers: { Authorization: `Bearer ${PROXY_SECRET}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.boot, events.boot);
    assert.deepEqual(body.events, events.all());
  } finally { await close(server); }
});

test("a canary CONNECT host trips the owner before any resolve and leaves the peer alone", async () => {
  const registry = createRegistry();
  const events = createEventLog();
  const logs = [];
  registry.setPolicy(AGENT, ["example.com"], false, { canaryHashes: [canaryHash(CANARY)] });
  registry.setPolicy(PEER, ["example.com"], false, { canaryHashes: [canaryHash(`ecx-${"b".repeat(32)}`)] });
  let resolved = false;
  const server = createDesktopProxy({
    desktopSecret: DESKTOP_SECRET, registry, events, log: (event) => logs.push(event),
    resolve: async () => { resolved = true; throw new Error("must not resolve"); },
    connect: () => { throw new Error("must not connect"); },
  });
  const port = await listen(server);
  try {
    const first = await rawRequest(port, [`CONNECT ${CANARY}.evil.test:443 HTTP/1.1`, `Host: ${CANARY}.evil.test:443`, authLine()]);
    assert.match(first.head, /^HTTP\/1\.1 403/);
    first.socket.destroy();
    assert.equal(resolved, false);
    assert.equal(registry.get(AGENT).tripped, true);
    assert.equal(registry.get(PEER).tripped, false);
    assert.equal(events.all().length, 1);
    assert.deepEqual(events.all()[0].source, "proxy_host");
    assert.equal(events.all()[0].agentId, AGENT);
    assert.equal(JSON.stringify(logs).includes(CANARY), false);
    assert.equal(JSON.stringify(logs).includes("evil.test"), false);
    const second = await rawRequest(port, ["CONNECT example.com:443 HTTP/1.1", authLine()]);
    assert.match(second.head, /^HTTP\/1\.1 403/);
    second.socket.destroy();
    assert.equal(events.all().length, 1, "a tripped agent does not create a second event");
  } finally { await close(server); }
});

test("a canary in a plain-HTTP header trips the owner as proxy_request", async () => {
  const registry = createRegistry();
  const events = createEventLog();
  registry.setPolicy(AGENT, ["example.com"], false, { canaryHashes: [canaryHash(CANARY)] });
  const server = createDesktopProxy({
    desktopSecret: DESKTOP_SECRET, registry, events,
    resolve: async () => { throw new Error("must not resolve"); },
    connect: () => { throw new Error("must not connect"); },
  });
  const port = await listen(server);
  try {
    const result = await rawRequest(port, [
      "GET http://example.com/ HTTP/1.1", "Host: example.com", `X-Api-Key: ${CANARY}`, authLine(),
    ]);
    assert.match(result.head, /^HTTP\/1\.1 403/);
    result.socket.destroy();
    assert.equal(registry.get(AGENT).tripped, true);
    assert.deepEqual(events.all().map((event) => event.source), ["proxy_request"]);
  } finally { await close(server); }
});
