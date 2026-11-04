import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { createDesktopProxy, parseConnectTarget, parseHttpTarget } from "../docker/egress/desktop-proxy.mjs";
import { createProxy, validatePolicy } from "../docker/egress/proxy.mjs";
import { canonicalDomains, createRegistry, egressToken, tokenMatches } from "../docker/egress/registry.mjs";
import { agentEgressToken } from "../docker/desktop/session-manager.mjs";
import { domain } from "../lib/agents/schema.ts";

const PROXY_SECRET = "ab".repeat(32);
const DESKTOP_SECRET = "cd".repeat(32);
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PEER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
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

function authLine(agent = AGENT, token) {
  return `Proxy-Authorization: Basic ${Buffer.from(`${agent}:${token}`).toString("base64")}`;
}

async function startEcho() {
  const received = [];
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => { received.push(chunk.toString()); socket.write(`echo:${chunk.toString()}`); });
    socket.on("error", () => {});
  });
  const port = await listen(server);
  return { server, port, received };
}

test("allowlist matching is exact-label and canonical", () => {
  assert.deepEqual(canonicalDomains(["Example.COM", "example.com", "a.example.com"]), ["a.example.com", "example.com"]);
  const registry = createRegistry();
  registry.setPolicy(AGENT, ["example.com"], false);
  assert.equal(registry.allows(AGENT, "example.com"), true);
  assert.equal(registry.allows(AGENT, "www.example.com"), true);
  assert.equal(registry.allows(AGENT, "badexample.com"), false);
  assert.equal(registry.allows(AGENT, "example.com.evil.test"), false);
  assert.equal(registry.allows(AGENT, "example.org"), false);
  assert.equal(registry.allows(PEER, "example.com"), false);
});

test("desktop and proxy token formulas agree and reject malformed tokens", () => {
  assert.equal(agentEgressToken(AGENT, DESKTOP_SECRET), egressToken(DESKTOP_SECRET, AGENT));
  assert.equal(tokenMatches(egressToken(DESKTOP_SECRET, AGENT), egressToken(DESKTOP_SECRET, AGENT)), true);
  assert.equal(tokenMatches(egressToken(DESKTOP_SECRET, PEER), egressToken(DESKTOP_SECRET, AGENT)), false);
  assert.equal(tokenMatches("not-a-token", egressToken(DESKTOP_SECRET, AGENT)), false);
  assert.notEqual(agentEgressToken(AGENT, DESKTOP_SECRET), agentEgressToken(AGENT, PROXY_SECRET));
});

test("CONNECT targets are HTTPS hostnames only; HTTP targets are absolute-form port 80", () => {
  assert.equal(parseConnectTarget("Example.COM:443"), "example.com");
  assert.equal(parseConnectTarget("example.com.:443"), "example.com");
  assert.equal(parseConnectTarget("example.com:80"), null);
  assert.equal(parseConnectTarget("1.2.3.4:443"), null);
  assert.equal(parseConnectTarget("[::1]:443"), null);
  assert.equal(parseConnectTarget("localhost:443"), null);
  assert.equal(parseConnectTarget("example.com:443/path"), null);
  assert.deepEqual(parseHttpTarget("http://Example.com/a?b=1"), { host: "example.com", path: "/a?b=1" });
  assert.equal(parseHttpTarget("https://example.com/"), null);
  assert.equal(parseHttpTarget("http://user@example.com/"), null);
  assert.equal(parseHttpTarget("http://example.com:8080/"), null);
  assert.equal(parseHttpTarget("/healthz"), null);
});

test("policy validation and the agent form accept and reject the same domains", () => {
  const proxyAccepts = (value) => {
    try { validatePolicy({ agentId: AGENT, domains: [value], blocked: false }); return true; } catch { return false; }
  };
  const appAccepts = (value) => domain.safeParse(value).success;
  for (const value of ["example.com", "sub.example.co.uk", "EXAMPLE.COM", "example.com", "xn--p1ai.example",
    "localhost", "a.b", "example.com.", "-bad.example.com", "1.2.3.4", "example..com", "exa mple.com", ""]) {
    assert.equal(proxyAccepts(value), appAccepts(value), value);
  }
  assert.throws(() => validatePolicy({ agentId: AGENT, domains: [], blocked: false, extra: true }));
  assert.throws(() => validatePolicy({ agentId: "not-a-uuid", domains: [], blocked: false }));
  assert.throws(() => validatePolicy({ agentId: AGENT, domains: ["example.com"], blocked: "no" }));
  assert.throws(() => validatePolicy({ agentId: AGENT, domains: Array.from({ length: 65 }, (_, i) => `d${i}.example.com`), blocked: false }));
});

test("policy pushes are authenticated and expire", async () => {
  let clock = 1_000;
  const registry = createRegistry({ now: () => clock });
  const server = createProxy({ secret: PROXY_SECRET, registry });
  const port = await listen(server);
  const send = (body, secret = PROXY_SECRET) => fetch(`http://127.0.0.1:${port}/v1/policy`, {
    method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await send({ agentId: AGENT, domains: ["example.com"], blocked: false }, "ef".repeat(32))).status, 401);
    assert.equal((await send({ agentId: AGENT, domains: ["example.com"], blocked: false, extra: true })).status, 400);
    assert.equal((await send({ agentId: AGENT, domains: ["10.0.0.1"], blocked: false })).status, 400);
    assert.equal((await send({ agentId: AGENT, domains: ["example.com"], blocked: false })).status, 200);
    assert.deepEqual(registry.get(AGENT)?.domains, ["example.com"]);
    assert.equal(registry.allows(AGENT, "www.example.com"), true);
    clock += 120_001;
    assert.equal(registry.get(AGENT), null);
    assert.equal(registry.allows(AGENT, "example.com"), false);
  } finally { await close(server); }
});

test("policy changes destroy tunnels; an unchanged refresh keeps them; expiry destroys them", () => {
  let clock = 1_000;
  const registry = createRegistry({ now: () => clock });
  const destroyed = [];
  const fake = () => ({ destroy: () => destroyed.push(true) });
  registry.setPolicy(AGENT, ["example.com"], false);
  const first = fake(), second = fake();
  assert.equal(registry.addTunnel(AGENT, first), true);
  assert.equal(registry.setPolicy(AGENT, ["example.com"], false).changed, false);
  assert.equal(destroyed.length, 0);
  assert.equal(registry.setPolicy(AGENT, ["example.org"], false).changed, true);
  assert.equal(destroyed.length, 1);
  assert.equal(registry.addTunnel(AGENT, second), true);
  assert.equal(registry.setPolicy(AGENT, ["example.org"], true).changed, true);
  assert.equal(destroyed.length, 2);
  registry.setPolicy(AGENT, ["example.org"], false);
  const third = fake();
  assert.equal(registry.addTunnel(AGENT, third), true);
  clock += 120_001;
  registry.sweep();
  assert.equal(destroyed.length, 3);
  assert.equal(registry.stats().tunnels, 0);
});

test("per-agent and total tunnel caps are enforced", () => {
  const registry = createRegistry({ maxPerAgent: 2, maxTotal: 3 });
  const fake = () => ({ destroy: () => {} });
  registry.setPolicy(AGENT, ["example.com"], false);
  registry.setPolicy(PEER, ["example.com"], false);
  assert.equal(registry.addTunnel(AGENT, fake()), true);
  assert.equal(registry.addTunnel(AGENT, fake()), true);
  assert.equal(registry.addTunnel(AGENT, fake()), false);
  assert.equal(registry.addTunnel(PEER, fake()), true);
  assert.equal(registry.addTunnel(PEER, fake()), false);
});

test("a CONNECT tunnel authenticates, checks the allowlist and pipes both ways", async () => {
  const registry = createRegistry();
  registry.setPolicy(AGENT, ["example.com"], false);
  const echo = await startEcho();
  const proxy = createDesktopProxy({ desktopSecret: DESKTOP_SECRET, registry, resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    connect: () => net.connect({ host: "127.0.0.1", port: echo.port }), log: () => {} });
  const port = await listen(proxy);
  try {
    const { socket, head } = await rawRequest(port, ["CONNECT example.com:443 HTTP/1.1", "Host: example.com:443", authLine(AGENT, egressToken(DESKTOP_SECRET, AGENT))]);
    assert.match(head, /^HTTP\/1\.1 200/);
    const reply = await new Promise((resolve) => { socket.once("data", (chunk) => resolve(chunk.toString())); socket.write("ping"); });
    assert.equal(reply, "echo:ping");
    socket.destroy();
  } finally { await close(proxy); await close(echo.server); }
});

test("CONNECT refusals happen before any upstream connection", async () => {
  const registry = createRegistry();
  registry.setPolicy(AGENT, ["example.com"], false);
  let connects = 0;
  const proxy = createDesktopProxy({ desktopSecret: DESKTOP_SECRET, registry, resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    connect: () => { connects += 1; throw new Error("must not connect"); }, log: () => {} });
  const port = await listen(proxy);
  const connect = async (lines) => (await rawRequest(port, lines)).head;
  try {
    const token = egressToken(DESKTOP_SECRET, AGENT);
    assert.match(await connect(["CONNECT example.com:443 HTTP/1.1", "Host: example.com:443"]), /^HTTP\/1\.1 407/);
    assert.match(await connect(["CONNECT example.com:443 HTTP/1.1", "Host: example.com:443", authLine(AGENT, egressToken(DESKTOP_SECRET, PEER))]), /^HTTP\/1\.1 407/);
    assert.match(await connect(["CONNECT example.com:443 HTTP/1.1", "Host: example.com:443", authLine(PEER, token)]), /^HTTP\/1\.1 407/);
    assert.match(await connect(["CONNECT example.org:443 HTTP/1.1", "Host: example.org:443", authLine(AGENT, token)]), /^HTTP\/1\.1 403/);
    assert.match(await connect(["CONNECT example.com:80 HTTP/1.1", "Host: example.com:80", authLine(AGENT, token)]), /^HTTP\/1\.1 403/);
    assert.match(await connect(["CONNECT 169.254.169.254:443 HTTP/1.1", "Host: 169.254.169.254:443", authLine(AGENT, token)]), /^HTTP\/1\.1 403/);
    assert.match(await connect(["GET http://example.com/path?q=1 HTTP/1.1", "Host: example.com", authLine(AGENT, token)]), /^HTTP\/1\.1 307/);
    assert.match(await connect(["GET http://example.org/ HTTP/1.1", "Host: example.org", authLine(AGENT, token)]), /^HTTP\/1\.1 403/);
    assert.match(await connect(["POST http://example.com/ HTTP/1.1", "Host: example.com", authLine(AGENT, token)]), /^HTTP\/1\.1 403/);
    assert.match(await connect(["GET /healthz HTTP/1.1", "Host: example.com", authLine(AGENT, token)]), /^HTTP\/1\.1 403/);
    assert.equal(connects, 0);
  } finally { await close(proxy); }
});

test("private DNS answers, unknown agents and blocked agents are refused", async () => {
  const registry = createRegistry();
  registry.setPolicy(AGENT, ["example.com"], false);
  registry.setPolicy(PEER, ["example.com"], true);
  const token = egressToken(DESKTOP_SECRET, AGENT);
  let connects = 0;
  const proxy = createDesktopProxy({ desktopSecret: DESKTOP_SECRET, registry,
    resolve: async (host) => host.startsWith("10.") ? [{ address: host, family: 4 }] : host.startsWith("169.") ? [{ address: host, family: 4 }] : [{ address: "93.184.216.34", family: 4 }],
    connect: () => { connects += 1; throw new Error("must not connect"); }, log: () => {} });
  const port = await listen(proxy);
  const connect = async (host, agent = AGENT, pass = token) => (await rawRequest(port, [`CONNECT ${host}:443 HTTP/1.1`, `Host: ${host}:443`, authLine(agent, pass)])).head;
  try {
    assert.match(await connect("10.0.0.1"), /^HTTP\/1\.1 403/);
    assert.match(await connect("169.254.169.254"), /^HTTP\/1\.1 403/);
    assert.match(await connect("example.com", PEER, egressToken(DESKTOP_SECRET, PEER)), /^HTTP\/1\.1 403/);
    assert.equal(connects, 0);
  } finally { await close(proxy); }
});

// ADR-036. "Any public website" widens the hostname check only: private, metadata and rebinding answers stay refused.
test("any-public policy allows public hosts but still refuses internal, metadata and rebinding targets", async () => {
  const registry = createRegistry();
  registry.setPolicy(AGENT, [], false, { anyPublic: true });
  registry.setPolicy(PEER, [], false);
  assert.equal(registry.allows(AGENT, "news.example.org"), true);
  assert.equal(registry.allows(PEER, "news.example.org"), false, "an empty allowlist without anyPublic still denies");
  assert.equal(registry.get(AGENT).anyPublic, true);
  assert.deepEqual(validatePolicy({ agentId: AGENT, domains: [], blocked: false, anyPublic: true }).anyPublic, true);
  assert.equal(validatePolicy({ agentId: AGENT, domains: [], blocked: false }).anyPublic, false);
  assert.throws(() => validatePolicy({ agentId: AGENT, domains: [], blocked: false, anyPublic: "yes" }), /invalid_policy/);
  const token = egressToken(DESKTOP_SECRET, AGENT);
  let connects = 0;
  const proxy = createDesktopProxy({ desktopSecret: DESKTOP_SECRET, registry,
    resolve: async (host) => host === "rebind.example.org" ? [{ address: "10.0.0.5", family: 4 }]
      : host === "meta.example.org" ? [{ address: "169.254.169.254", family: 4 }] : [{ address: "93.184.216.34", family: 4 }],
    connect: () => { connects += 1; throw new Error("must not connect"); }, log: () => {} });
  const port = await listen(proxy);
  const connect = async (host) => (await rawRequest(port, [`CONNECT ${host}:443 HTTP/1.1`, `Host: ${host}:443`, authLine(AGENT, token)])).head;
  try {
    assert.match(await connect("10.0.0.1"), /^HTTP\/1\.1 403/);
    assert.match(await connect("169.254.169.254"), /^HTTP\/1\.1 403/);
    assert.match(await connect("rebind.example.org"), /^HTTP\/1\.1 403/);
    assert.match(await connect("meta.example.org"), /^HTTP\/1\.1 403/);
    assert.equal(connects, 0);
  } finally { await close(proxy); }
  // Turning anyPublic off is a policy change: the agent is back to its (empty) allowlist.
  registry.setPolicy(AGENT, [], false, { anyPublic: false });
  assert.equal(registry.allows(AGENT, "news.example.org"), false);
});

test("DNS is pinned to the first checked address and a mixed private answer is refused", async () => {
  const registry = createRegistry();
  registry.setPolicy(AGENT, ["example.com"], false);
  const seen = [];
  const proxy = createDesktopProxy({ desktopSecret: DESKTOP_SECRET, registry,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }, { address: "1.1.1.1", family: 4 }],
    connect: (options) => { seen.push(options); throw new Error("stop"); }, log: () => {} });
  const port = await listen(proxy);
  try {
    await rawRequest(port, ["CONNECT example.com:443 HTTP/1.1", "Host: example.com:443", authLine(AGENT, egressToken(DESKTOP_SECRET, AGENT))]);
    assert.deepEqual(seen[0], { host: "93.184.216.34", port: 443, family: 4 });
  } finally { await close(proxy); }

  const blocked = createDesktopProxy({ desktopSecret: DESKTOP_SECRET, registry,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }],
    connect: () => { throw new Error("must not connect"); }, log: () => {} });
  const blockedPort = await listen(blocked);
  try {
    const { head } = await rawRequest(blockedPort, ["CONNECT example.com:443 HTTP/1.1", "Host: example.com:443", authLine(AGENT, egressToken(DESKTOP_SECRET, AGENT))]);
    assert.match(head, /^HTTP\/1\.1 403/);
  } finally { await close(blocked); }
});

test("proxy logs never contain the desktop secret or token", async () => {
  const registry = createRegistry();
  registry.setPolicy(AGENT, ["example.com"], false);
  const logs = [];
  const proxy = createDesktopProxy({ desktopSecret: DESKTOP_SECRET, registry, resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    connect: () => { throw new Error("stop"); }, log: (event) => logs.push(event) });
  const port = await listen(proxy);
  const token = egressToken(DESKTOP_SECRET, AGENT);
  try {
    await rawRequest(port, ["CONNECT example.org:443 HTTP/1.1", "Host: example.org:443", authLine(AGENT, token)]);
    await rawRequest(port, ["CONNECT example.com:443 HTTP/1.1", "Host: example.com:443", authLine(AGENT, egressToken(DESKTOP_SECRET, PEER))]);
  } finally { await close(proxy); }
  const text = JSON.stringify(logs);
  assert.ok(logs.some((event) => event.reason === "not_allowed" && event.host === "example.org"));
  assert.ok(!text.includes(token));
  assert.ok(!text.includes(DESKTOP_SECRET));
  assert.ok(!text.includes(PROXY_SECRET));
});
