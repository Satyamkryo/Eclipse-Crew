import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { credentialsVersion as appVersion } from "../lib/connections/version.ts";
import { createCredentialStore, credentialsVersion } from "../docker/egress/credentials.mjs";
import { createProxy } from "../docker/egress/proxy.mjs";
import { createRegistry } from "../docker/egress/registry.mjs";

const SECRET = "ab".repeat(32);
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PEER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN = "github_pat_11AAABBBCCCDDDEEEFFF123456789";
const PUBLIC = [{ address: "140.82.112.6", family: 4 }];

function fakeUpstream(handler) {
  const seen = [];
  const upstream = (options, onResponse) => {
    const chunks = [];
    const record = { options, body: () => Buffer.concat(chunks) };
    seen.push(record);
    const request = new Writable({
      write(chunk, _encoding, next) { chunks.push(chunk); next(); },
      final(next) {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = { "content-type": "application/json" };
        Promise.resolve(handler(record, response)).then(() => { onResponse(response); next(); });
      },
    });
    request.setTimeout = () => request;
    request.destroy = () => request.emit("close");
    return request;
  };
  upstream.seen = seen;
  return upstream;
}
const reply = (status, body, headers = {}) => (_record, response) => {
  response.statusCode = status;
  response.headers = { "content-type": "application/json", ...headers };
  setImmediate(() => response.end(body));
};

async function withProxy({ ttlMs = 120_000, now } = {}, fn) {
  const credentials = createCredentialStore();
  const registry = createRegistry({ ttlMs, ...(now ? { now } : {}), onRemove: (agentId) => credentials.remove(agentId) });
  registry.setPolicy(AGENT, ["api.github.com", "api.githubcopilot.com", "github.com"], false);
  registry.setPolicy(PEER, ["api.github.com"], false);
  const logs = [];
  const upstream = fakeUpstream(reply(200, JSON.stringify({ ok: true }), { "mcp-session-id": "session-1", "set-cookie": "secret=1" }));
  const server = createProxy({ secret: SECRET, registry, credentials, upstream, resolve: async () => PUBLIC, log: (event) => logs.push(event) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn({ base, registry, credentials, upstream, logs }); }
  finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); }
}

function putCredentials(base, agentId = AGENT, entries) {
  return fetch(`${base}/v1/credentials`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, credentials: entries }),
  });
}
function toolForward(base, { agent = AGENT, target = "https://api.github.com/user", method = "GET", body, headers = {} } = {}) {
  return fetch(`${base}/v1/tool-forward`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SECRET}`, "X-Eclipse-Agent": agent, "X-Eclipse-Target": target,
      "X-Eclipse-Method": method, ...headers,
    },
    body,
  });
}

test("the app and the proxy compute the same credential version", () => {
  const entries = [
    { host: "github.com", scheme: "basic", header: null, username: "x-access-token", token: TOKEN },
    { host: "api.github.com", scheme: "bearer", header: null, username: null, token: TOKEN },
  ];
  assert.equal(appVersion(entries), credentialsVersion([...entries].reverse()));
  assert.notEqual(appVersion(entries), credentialsVersion([{ ...entries[0], token: `${TOKEN}-other` }]));
});

test("the credential store rejects malformed entries and de-duplicates by host", () => {
  const store = createCredentialStore();
  assert.throws(() => store.set(AGENT, [{ host: "API.github.com", scheme: "bearer", token: TOKEN }]), /invalid_credentials/);
  assert.throws(() => store.set(AGENT, [{ host: "127.0.0.1", scheme: "bearer", token: TOKEN }]), /invalid_credentials/);
  assert.throws(() => store.set(AGENT, [{ host: "api.github.com", scheme: "bearer", token: "short" }]), /invalid_credentials/);
  assert.throws(() => store.set(AGENT, [{ host: "api.github.com", scheme: "header", header: "authorization", token: TOKEN }]), /invalid_credentials/);
  assert.throws(() => store.set(AGENT, [
    { host: "api.github.com", scheme: "bearer", token: TOKEN },
    { host: "api.github.com", scheme: "header", header: "x-api-key", token: TOKEN },
  ]), /invalid_credentials/);
  store.set(AGENT, [{ host: "api.github.com", scheme: "bearer", token: TOKEN }]);
  assert.equal(store.lookup(AGENT, "api.github.com")?.token, TOKEN);
  assert.equal(store.lookup(PEER, "api.github.com"), null);
  assert.equal(store.set(AGENT, []), null);
  assert.equal(store.version(AGENT), null);
});

test("credentials are accepted only from the app and are versioned", async () => {
  await withProxy({}, async ({ base, credentials }) => {
    const bad = await fetch(`${base}/v1/credentials`, {
      method: "POST", headers: { Authorization: `Bearer ${"cd".repeat(32)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: AGENT, credentials: [] }),
    });
    assert.equal(bad.status, 401);
    const entry = { host: "api.github.com", scheme: "bearer", header: null, username: null, token: TOKEN };
    const response = await putCredentials(base, AGENT, [entry]);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.credentialsVersion, appVersion([entry]));
    assert.equal(JSON.stringify(body).includes(TOKEN), false);
    assert.equal(credentials.version(AGENT), body.credentialsVersion);
  });
});

test("a bearer, basic or header binding is injected exactly once", async () => {
  await withProxy({}, async ({ base, upstream }) => {
    await putCredentials(base, AGENT, [
      { host: "api.github.com", scheme: "bearer", header: null, username: null, token: TOKEN },
      { host: "github.com", scheme: "basic", header: null, username: "x-access-token", token: TOKEN },
      { host: "api.githubcopilot.com", scheme: "header", header: "x-api-key", username: null, token: TOKEN },
    ]);
    await toolForward(base, { headers: { "X-Eclipse-Credential": TOKEN, "Content-Type": "application/json", "mcp-session-id": "s" } });
    assert.equal(upstream.seen.at(-1).options.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(upstream.seen.at(-1).options.headers["mcp-session-id"], "s");
    await toolForward(base, { target: "https://github.com/owner/repo.git" });
    assert.equal(upstream.seen.at(-1).options.headers.authorization,
      `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`);
    await toolForward(base, { target: "https://api.githubcopilot.com/mcp/" });
    assert.equal(upstream.seen.at(-1).options.headers["x-api-key"], TOKEN);
    assert.equal(upstream.seen.at(-1).options.headers.authorization, undefined);
  });
});

test("a peer agent never gets another agent's credential", async () => {
  await withProxy({}, async ({ base, upstream }) => {
    await putCredentials(base, AGENT, [{ host: "api.github.com", scheme: "bearer", header: null, username: null, token: TOKEN }]);
    const response = await toolForward(base, { agent: PEER });
    assert.equal(response.status, 200);
    assert.equal(upstream.seen.at(-1).options.headers.authorization, undefined);
  });
});

test("unknown, blocked and tripped agents are refused before any upstream call", async () => {
  await withProxy({}, async ({ base, registry, credentials, upstream }) => {
    await putCredentials(base, AGENT, [{ host: "api.github.com", scheme: "bearer", header: null, username: null, token: TOKEN }]);
    const unknown = await toolForward(base, { agent: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
    assert.equal(unknown.status, 403);
    assert.equal((await unknown.json()).error, "agent_unavailable");
    registry.setPolicy(AGENT, ["api.github.com"], true);
    assert.equal(credentials.version(AGENT), null, "blocking wipes the agent's credentials");
    const blocked = await toolForward(base);
    assert.equal(blocked.status, 403);
    registry.setPolicy(AGENT, ["api.github.com"], false);
    credentials.set(AGENT, [{ host: "api.github.com", scheme: "bearer", header: null, username: null, token: TOKEN }]);
    registry.trip(AGENT);
    assert.equal(credentials.version(AGENT), null, "tripping wipes the agent's credentials");
    const tripped = await toolForward(base);
    assert.equal(tripped.status, 403);
    assert.equal(upstream.seen.length, 0);
  });
});

test("expired policies take their credentials with them", async () => {
  let clock = 1_000;
  await withProxy({ ttlMs: 100, now: () => clock }, async ({ base, registry, credentials }) => {
    await putCredentials(base, AGENT, [{ host: "api.github.com", scheme: "bearer", header: null, username: null, token: TOKEN }]);
    assert.ok(credentials.version(AGENT));
    clock += 1_000;
    assert.equal(registry.get(AGENT), null);
    assert.equal(credentials.version(AGENT), null);
  });
});

test("a credential never survives in any response encoding", async () => {
  const leaked = [
    TOKEN,
    Buffer.from(TOKEN).toString("base64"),
    encodeURIComponent(TOKEN),
    Buffer.from(`x-access-token:${TOKEN}`).toString("base64"),
  ];
  const upstream = fakeUpstream(reply(200, JSON.stringify({ echo: leaked })));
  const credentials = createCredentialStore();
  credentials.set(AGENT, [
    { host: "api.github.com", scheme: "bearer", header: null, username: null, token: TOKEN },
    { host: "github.com", scheme: "basic", header: null, username: "x-access-token", token: TOKEN },
  ]);
  const registry = createRegistry({ onRemove: (agentId) => credentials.remove(agentId) });
  registry.setPolicy(AGENT, ["api.github.com", "github.com"], false);
  const server = createProxy({ secret: SECRET, registry, credentials, upstream, resolve: async () => PUBLIC });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await putCredentials(base, AGENT, [
      { host: "api.github.com", scheme: "bearer", header: null, username: null, token: TOKEN },
      { host: "github.com", scheme: "basic", header: null, username: "x-access-token", token: TOKEN },
    ]);
    for (const target of ["https://api.github.com/user", "https://github.com/owner/repo.git"]) {
      const response = await toolForward(base, { target });
      const text = await response.text();
      for (const value of leaked) assert.equal(text.includes(value), false, value);
    }
  } finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); }
});

test("a canary in the body trips the agent and refuses the call", async () => {
  const canary = `ecx-${"d".repeat(32)}`;
  const { canaryHash } = await import("../docker/egress/canary.mjs");
  await withProxy({}, async ({ base, registry, credentials, upstream }) => {
    registry.setPolicy(AGENT, ["api.github.com"], false, { canaryHashes: [canaryHash(canary)] });
    await putCredentials(base, AGENT, [{ host: "api.github.com", scheme: "bearer", header: null, username: null, token: TOKEN }]);
    const response = await toolForward(base, { method: "POST", body: JSON.stringify({ text: canary }), headers: { "Content-Type": "application/json" } });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "canary_blocked");
    assert.equal(registry.get(AGENT).tripped, true);
    assert.equal(credentials.version(AGENT), null);
    assert.equal(upstream.seen.length, 0);
  });
});

test("the response keeps only the allowlisted headers and drops cookies and locations", async () => {
  const upstream = fakeUpstream(reply(200, "{}", { "mcp-session-id": "mcp-2", "retry-after": "3", "set-cookie": "a=b", location: "https://evil.test/" }));
  const credentials = createCredentialStore();
  credentials.set(AGENT, [{ host: "api.github.com", scheme: "bearer", header: null, username: null, token: TOKEN }]);
  const registry = createRegistry();
  registry.setPolicy(AGENT, ["api.github.com"], false);
  const server = createProxy({ secret: SECRET, registry, credentials, upstream, resolve: async () => PUBLIC });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await toolForward(base);
    assert.equal(response.headers.get("mcp-session-id"), "mcp-2");
    assert.equal(response.headers.get("retry-after"), "3");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("location"), null);
  } finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); }
});

test("tool-forward validates its target and method", async () => {
  await withProxy({}, async ({ base }) => {
    for (const init of [
      { target: "http://api.github.com/user" },
      { target: "https://127.0.0.1/user" },
      { target: "https://169.254.169.254/latest" },
      { method: "OPTIONS" },
    ]) {
      const response = await toolForward(base, init);
      assert.ok(response.status >= 400, JSON.stringify(init));
    }
  });
});

test("the policy reply carries the current credentials version", async () => {
  await withProxy({}, async ({ base, credentials }) => {
    await putCredentials(base, AGENT, [{ host: "api.github.com", scheme: "bearer", header: null, username: null, token: TOKEN }]);
    const response = await fetch(`${base}/v1/policy`, {
      method: "POST", headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: AGENT, domains: ["api.github.com"], blocked: false }),
    });
    const body = await response.json();
    assert.equal(body.credentialsVersion, credentials.version(AGENT));
  });
});
