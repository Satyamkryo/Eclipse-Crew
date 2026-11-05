import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { createProxy, parseLocalTarget } from "../docker/egress/proxy.mjs";
import { isLocalModelAddress, ownSubnets } from "../docker/egress/addresses.mjs";
import { isLocalBaseUrl, resolveModelPrice } from "../lib/costs/pricing.ts";
import { isLocalModelUrl, isLoopbackModelUrl } from "../lib/providers/local.ts";
import { createLocalProxyTransport } from "../lib/providers/proxy-transport.ts";
import { localProbeSchema, samModelSettingsSchema } from "../lib/models/schema.ts";
import { saveBackgroundSettings, saveMainSettings, saveSamSettings } from "../lib/models/service.ts";
import { probeLocalServer, testSavedRole } from "../lib/models/testing.ts";
import { connectorForProvider, HOSTED_PROVIDER_TIMEOUT_MS, isLocalProvider, LOCAL_PROVIDER_TIMEOUT_MS, proxyTransportFor } from "../lib/models/transport.ts";
import { encryptSecret } from "../lib/security/encryption.ts";

const ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
const SECRET = "ab".repeat(32);
const META_KEY = "sk-meta-CANARY-1234567890abcdef";
const LOCAL_KEY = "llama-cpp-CANARY-key-123456";
const OLLAMA = "http://host.docker.internal:11434/v1";

async function withEnv(operation) {
  const previous = { key: process.env.ENCRYPTION_KEY, secret: process.env.EGRESS_PROXY_SECRET };
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  process.env.EGRESS_PROXY_SECRET = SECRET;
  try { return await operation(); } finally {
    for (const [name, value] of [["ENCRYPTION_KEY", previous.key], ["EGRESS_PROXY_SECRET", previous.secret]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

// In-memory double of ModelSettingsStore that mirrors the key rules of lib/models/data.ts.
class MemoryStore {
  constructor() { this.main = null; this.sam = null; this.background = null; }
  async load() { return structuredClone({ main: this.main, sam: this.sam, background: this.background }); }
  provider(previous, kind, baseUrl, input) {
    // Like data.ts: an explicit clearKey, or a kind change without a new key, drops the saved key.
    const clear = input.encryptedKey === undefined && Boolean(input.clearKey || (previous && previous.kind !== kind));
    return {
      id: previous?.id ?? randomUUID(), kind, baseUrl,
      encryptedKey: input.encryptedKey ?? (clear ? null : previous?.encryptedKey ?? null),
      keyHint: input.keyHint ?? (clear ? null : previous?.keyHint ?? null),
    };
  }
  async saveMain(_owner, input) {
    const stored = this.provider(this.main?.provider, input.kind, input.baseUrl, input);
    this.main = { role: "main", providerId: stored.id, provider: stored, model: input.model, useMainKey: false, mode: "active", routing: input.routing, hardModel: input.hardModel };
  }
  async saveSam(_owner, input) {
    if (input.mode === "off") { this.sam = null; return; }
    if (input.mode === "meta" && input.useMainKey) {
      this.sam = { role: "sam", providerId: this.main.provider.id, provider: this.main.provider, model: "sam-3.1", useMainKey: true, mode: "meta", routing: "fixed", hardModel: null };
      return;
    }
    const kind = input.mode === "local" ? "openai-compatible" : "meta";
    const baseUrl = input.mode === "local" ? input.baseUrl : null;
    const previous = this.sam && !this.sam.useMainKey ? this.sam.provider : null;
    const changed = previous && (previous.kind !== kind || previous.baseUrl !== baseUrl);
    const stored = {
      id: previous?.id ?? randomUUID(), kind, baseUrl,
      encryptedKey: input.encryptedKey ?? (changed ? null : previous?.encryptedKey ?? null),
      keyHint: input.keyHint ?? (changed ? null : previous?.keyHint ?? null),
    };
    this.sam = { role: "sam", providerId: stored.id, provider: stored, model: "sam-3.1", useMainKey: false, mode: input.mode, routing: "fixed", hardModel: null };
  }
  async saveBackground(_owner, input) {
    if (input.mode === "off") { this.background = null; return; }
    const stored = this.provider(this.background?.provider, input.kind, input.baseUrl, input);
    this.background = { role: "background", providerId: stored.id, provider: stored, model: input.model, useMainKey: false, mode: "active", routing: "fixed", hardModel: null };
  }
}

async function expectCode(code, operation) {
  await assert.rejects(operation, (error) => { assert.equal(error.code, code); return true; });
}

test("local addresses: this computer, LAN, Tailscale and Docker names are local; hosted and public IPs are not", () => {
  for (const url of [OLLAMA, "http://192.168.1.20:1234/v1", "http://10.0.0.5:8000/v1", "http://100.101.102.103:11434/v1",
    "http://my-pc.tail1234.ts.net:11434/v1", "http://gpu-box.lan:8080/v1", "http://ollama:11434/v1", "http://[fd7a:115c:a1e0::1]:11434/v1"]) {
    assert.equal(isLocalModelUrl(url), true, url);
  }
  for (const url of ["https://api.openai.com/v1", "https://openrouter.ai/api/v1", "http://8.8.8.8/v1", "http://100.200.0.1/v1", "not a url", null]) {
    assert.equal(isLocalModelUrl(url), false, String(url));
  }
  for (const url of ["http://localhost:11434/v1", "http://127.0.0.1:11434/v1", "http://[::1]:8080/v1", "http://0.0.0.0:1234/v1"]) {
    assert.equal(isLoopbackModelUrl(url), true, url);
  }
  assert.equal(isLoopbackModelUrl(OLLAMA), false);
  // Pricing uses the same rule: a Tailscale model costs nothing, a hosted one is priced or refused.
  assert.equal(isLocalBaseUrl("http://my-pc.tail1234.ts.net:11434/v1"), true);
  assert.deepEqual(resolveModelPrice({ kind: "openai-compatible", baseUrl: "http://100.101.1.2:11434/v1", model: "muse-glimmer" }).outputMicroUsdPerMillion, 0);
  assert.equal(resolveModelPrice({ kind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", model: "muse-glimmer" }), null);
});

test("Main AI: a local server saves without a key; hosted needs one; localhost is explained", async () => {
  await withEnv(async () => {
    const store = new MemoryStore();
    const saved = await saveMainSettings(store, "owner", { kind: "openai-compatible", model: "muse-glimmer", baseUrl: OLLAMA, routing: "fixed" });
    assert.equal(saved.main.configured, true);
    assert.equal(saved.main.baseUrl, OLLAMA);
    assert.equal(saved.main.hasKey, false);
    await expectCode("key_required", () => saveMainSettings(store, "owner", { kind: "openai-compatible", model: "gpt-x", baseUrl: "https://api.example.com/v1", routing: "fixed" }));
    await expectCode("loopback_not_reachable", () => saveMainSettings(store, "owner", { kind: "openai-compatible", model: "muse-glimmer", baseUrl: "http://localhost:11434/v1", routing: "fixed" }));
  });
});

test("a saved key never follows the owner to a different server", async () => {
  await withEnv(async () => {
    const store = new MemoryStore();
    await saveMainSettings(store, "owner", { kind: "openai-compatible", model: "gpt-x", baseUrl: "https://api.example.com/v1", apiKey: META_KEY, routing: "fixed" });
    assert.ok(store.main.provider.encryptedKey);
    // Same origin, different path: the key is kept.
    await saveMainSettings(store, "owner", { kind: "openai-compatible", model: "gpt-x", baseUrl: "https://api.example.com/v2", routing: "fixed" });
    assert.ok(store.main.provider.encryptedKey);
    // Moving to a local server drops the hosted key.
    const local = await saveMainSettings(store, "owner", { kind: "openai-compatible", model: "muse-glimmer", baseUrl: OLLAMA, routing: "fixed" });
    assert.equal(local.main.hasKey, false);
    assert.equal(store.main.provider.encryptedKey, null);
  });
});

test("Background: a local model saves without a key and hosted needs one", async () => {
  await withEnv(async () => {
    const store = new MemoryStore();
    const saved = await saveBackgroundSettings(store, "owner", { enabled: true, kind: "openai-compatible", model: "muse-glimmer", baseUrl: OLLAMA });
    assert.equal(saved.background.configured, true);
    await expectCode("key_required", () => saveBackgroundSettings(store, "owner", { enabled: true, kind: "openai-compatible", model: "x", baseUrl: "https://api.example.com/v1" }));
  });
});

test("SAM local: schema, save without key, and no key crosses between Meta and the local server", async () => {
  assert.equal(samModelSettingsSchema.safeParse({ mode: "local", useMainKey: false, baseUrl: "http://host.docker.internal:8090/v1" }).success, true);
  assert.equal(samModelSettingsSchema.safeParse({ mode: "local", useMainKey: false }).success, false);
  assert.equal(samModelSettingsSchema.safeParse({ mode: "local", useMainKey: true, baseUrl: "http://host.docker.internal:8090/v1" }).success, false);
  assert.equal(samModelSettingsSchema.safeParse({ mode: "meta", useMainKey: true, baseUrl: "http://host.docker.internal:8090/v1" }).success, false);
  await withEnv(async () => {
    const store = new MemoryStore();
    await saveSamSettings(store, "owner", { mode: "meta", useMainKey: false, apiKey: META_KEY });
    assert.ok(store.sam.provider.encryptedKey);
    const local = await saveSamSettings(store, "owner", { mode: "local", useMainKey: false, baseUrl: "http://host.docker.internal:8090/v1" });
    assert.deepEqual({ mode: local.sam.mode, baseUrl: local.sam.baseUrl, configured: local.sam.configured, hasKey: local.sam.hasKey },
      { mode: "local", baseUrl: "http://host.docker.internal:8090/v1", configured: true, hasKey: false });
    assert.equal(store.sam.provider.kind, "openai-compatible");
    assert.equal(store.sam.provider.encryptedKey, null, "the Meta key must not be sent to the local server");
    await saveSamSettings(store, "owner", { mode: "local", useMainKey: false, baseUrl: "http://host.docker.internal:8090/v1", apiKey: LOCAL_KEY });
    // Back to Meta: the local server's key is not reused for Meta.
    await expectCode("key_required", () => saveSamSettings(store, "owner", { mode: "meta", useMainKey: false }));
    await expectCode("key_required", () => saveSamSettings(store, "owner", { mode: "local", useMainKey: false, baseUrl: "https://sam.example.com/v1" }));
    await expectCode("loopback_not_reachable", () => saveSamSettings(store, "owner", { mode: "local", useMainKey: false, baseUrl: "http://127.0.0.1:8090/v1" }));
  });
});

test("local providers use the proxy's local route, with or without a key; hosted ones still need a key", async () => {
  await withEnv(async () => {
    const local = { id: "p", kind: "openai-compatible", baseUrl: OLLAMA, encryptedKey: null, keyHint: null };
    assert.equal(isLocalProvider(local), true);
    assert.equal(typeof proxyTransportFor(local), "function");
    assert.equal(proxyTransportFor({ ...local, baseUrl: "https://api.example.com/v1" }), null);
    assert.equal(isLocalProvider({ kind: "meta", baseUrl: null }), false);
    assert.equal(typeof proxyTransportFor({ ...local, encryptedKey: encryptSecret(LOCAL_KEY) }), "function");
    assert.equal(LOCAL_PROVIDER_TIMEOUT_MS, 120_000);
    // Hosted calls get longer than the 30 s library default but stay under the egress proxy's 60 s cap.
    assert.ok(HOSTED_PROVIDER_TIMEOUT_MS > 30_000 && HOSTED_PROVIDER_TIMEOUT_MS < 60_000);
    assert.ok(connectorForProvider(local, async () => new Response("{}")));
  });
});

test("the local transport sends target, method and optional key to /v1/local-forward only", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return new Response('{"data":[]}', { headers: { "x-eclipse-proxy": "ok" } }); };
  const keyless = createLocalProxyTransport({ secret: SECRET, fetchImpl });
  await keyless(`${OLLAMA}/models`, { method: "GET", headers: { Accept: "application/json", Authorization: "Bearer smuggled" } });
  assert.equal(seen[0].url, "http://egress-proxy:4320/v1/local-forward");
  assert.equal(seen[0].init.headers["X-Eclipse-Target"], `${OLLAMA}/models`);
  assert.equal(seen[0].init.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(seen[0].init.headers["X-Eclipse-Credential"], undefined);
  const keyed = createLocalProxyTransport({ secret: SECRET, fetchImpl, credential: LOCAL_KEY });
  await keyed(`${OLLAMA}/chat/completions`, { method: "POST", body: "{}" });
  assert.equal(seen[1].init.headers["X-Eclipse-Credential"], LOCAL_KEY);
  await assert.rejects(() => keyless("ftp://host.docker.internal/models"), /egress_target_not_allowed/);
  await assert.rejects(() => keyless(`${OLLAMA}/models`, { method: "DELETE" }), /egress_method_not_allowed/);
  const refused = createLocalProxyTransport({ secret: SECRET, fetchImpl: async () => new Response("{}", { status: 403 }) });
  await assert.rejects(() => refused(`${OLLAMA}/models`), /egress_proxy_error/);
});

test("Check server and Detect list local models and refuse hosted or loopback addresses", async () => {
  assert.equal(localProbeSchema.safeParse({ detect: true }).success, true);
  assert.equal(localProbeSchema.safeParse({ baseUrl: OLLAMA, extra: 1 }).success, false);
  const keys = [];
  const transport = (credential) => { keys.push(credential); return async (url) => {
    if (String(url).startsWith("http://host.docker.internal:11434/")) {
      return new Response(JSON.stringify({ data: [{ id: "muse-glimmer" }, { id: "qwen" }] }), { headers: { "content-type": "application/json" } });
    }
    throw new Error("connection refused");
  }; };
  const found = await probeLocalServer({ detect: true }, transport);
  assert.deepEqual(found.servers.map((server) => [server.id, server.models.map((model) => model.id)]), [["ollama", ["muse-glimmer", "qwen"]]]);
  const one = await probeLocalServer({ baseUrl: OLLAMA, apiKey: LOCAL_KEY }, transport);
  assert.deepEqual(one.models.map((model) => model.id), ["muse-glimmer", "qwen"]);
  assert.equal(keys.at(-1), LOCAL_KEY);
  await expectCode("not_local_address", () => probeLocalServer({ baseUrl: "https://api.openai.com/v1" }, transport));
  await expectCode("loopback_not_reachable", () => probeLocalServer({ baseUrl: "http://localhost:11434/v1" }, transport));
  await expectCode("provider_test_failed", () => probeLocalServer({ baseUrl: "http://host.docker.internal:1234/v1" }, transport));
});

test("Test works for a saved local SAM server", async () => {
  const store = new MemoryStore();
  store.sam = { role: "sam", providerId: "s", provider: { id: "s", kind: "openai-compatible", baseUrl: "http://host.docker.internal:8090/v1", encryptedKey: null, keyHint: null },
    model: "sam-3.1", useMainKey: false, mode: "local", routing: "fixed", hardModel: null };
  const urls = [];
  const result = await testSavedRole(store, "owner", "sam", async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ data: [{ id: "sam-3.1" }] }), { headers: { "content-type": "application/json" } });
  });
  assert.deepEqual(urls, ["http://host.docker.internal:8090/v1/models"]);
  assert.deepEqual(result.models.map((model) => model.id), ["sam-3.1"]);
});

// ---- egress proxy: /v1/local-forward ----

function fakeUpstream(status, body) {
  const seen = [];
  const upstream = (options, onResponse) => {
    const chunks = [];
    seen.push({ options, body: () => Buffer.concat(chunks) });
    const request = new Writable({
      write(chunk, _encoding, next) { chunks.push(chunk); next(); },
      final(next) {
        const response = new PassThrough();
        response.statusCode = status; response.headers = { "content-type": "application/json" };
        onResponse(response); next();
        setImmediate(() => response.end(typeof body === "function" ? body(seen.at(-1)) : body));
      },
    });
    request.setTimeout = () => request; request.destroy = () => request.emit("close");
    return request;
  };
  upstream.seen = seen;
  return upstream;
}

async function withProxy({ resolve, http, https, interfaces = {} }, fn) {
  const server = createProxy({ secret: SECRET, resolve, log: () => {}, interfaces,
    localUpstream: { http: http ?? fakeUpstream(200, "{}"), https: https ?? fakeUpstream(200, "{}") } });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const local = ({ target, method = "GET", credential, secret = SECRET, body } = {}) => fetch(`${base}/v1/local-forward`, {
    method: "POST", body,
    headers: { Authorization: `Bearer ${secret}`, "X-Eclipse-Target": target, "X-Eclipse-Method": method, ...(credential ? { "X-Eclipse-Credential": credential } : {}) },
  });
  try { return await fn(local); } finally { await new Promise((done) => { server.close(done); server.closeAllConnections(); }); }
}

test("proxy local route: shape rules for targets", () => {
  assert.deepEqual(parseLocalTarget("http://host.docker.internal:11434/v1/models"), { host: "host.docker.internal", literal: false, port: 11434, secure: false, path: "/v1/models" });
  assert.equal(parseLocalTarget("https://my-pc.tail1.ts.net/v1").port, 443);
  for (const bad of ["ftp://host/v1", "http://user:pass@host/v1", "http://host/v1#x", "http://bad_host/v1", "javascript:alert(1)"]) {
    assert.throws(() => parseLocalTarget(bad), (error) => error.code === "forbidden_target", bad);
  }
});

test("proxy local route: only the owner's private network, never loopback, metadata, public or the proxy's own subnets", () => {
  const own = ownSubnets({ eth0: [{ address: "172.20.0.3", cidr: "172.20.0.3/16", internal: false }], lo: [{ address: "127.0.0.1", cidr: "127.0.0.1/8", internal: true }] });
  for (const address of ["192.168.65.254", "172.17.0.1", "10.1.2.3", "100.101.1.2", "fd7a:115c:a1e0::1"]) assert.equal(isLocalModelAddress(address, own), true, address);
  for (const address of ["172.20.0.9", "127.0.0.1", "169.254.169.254", "8.8.8.8", "::1", "fe80::1", "::ffff:10.0.0.1", "224.0.0.1", "nonsense"]) {
    assert.equal(isLocalModelAddress(address, own), false, address);
  }
});

test("proxy local route forwards to a local server over HTTP, pins the address, injects and redacts an optional key", async () => {
  const http = fakeUpstream(200, (record) => JSON.stringify({ echoed: record.options.headers.authorization ?? null, data: [{ id: "muse-glimmer" }] }));
  await withProxy({ resolve: async () => [{ address: "192.168.65.254", family: 4 }], http }, async (local) => {
    const keyless = await local({ target: "http://host.docker.internal:11434/v1/models" });
    assert.equal(keyless.status, 200);
    assert.equal(keyless.headers.get("x-eclipse-proxy"), "ok");
    assert.equal(http.seen[0].options.port, 11434);
    assert.equal(http.seen[0].options.headers.authorization, undefined);
    assert.equal(http.seen[0].options.headers.host, "host.docker.internal:11434");
    const pinned = await new Promise((done) => http.seen[0].options.lookup("x", {}, (_e, address) => done(address)));
    assert.equal(pinned, "192.168.65.254");
    const keyed = await local({ target: "http://host.docker.internal:8080/v1/models", credential: LOCAL_KEY });
    const text = await keyed.text();
    assert.equal(http.seen[1].options.headers.authorization, `Bearer ${LOCAL_KEY}`);
    assert.equal(text.includes(LOCAL_KEY), false, "a reflected key is redacted");
    await keyless.body?.cancel();
  });
});

test("proxy local route refuses public, loopback and own-network targets and requires the app secret", async () => {
  const http = fakeUpstream(200, "{}");
  const addresses = { "public.example": "93.184.216.34", "meta-data": "169.254.169.254", app: "172.20.0.2", gw: "172.17.0.1" };
  await withProxy({
    resolve: async (host) => [{ address: addresses[host] ?? "10.0.0.1", family: 4 }], http,
    interfaces: { eth0: [{ address: "172.20.0.3", cidr: "172.20.0.3/16", internal: false }] },
  }, async (local) => {
    for (const target of ["http://public.example/v1/models", "http://meta-data/latest", "http://app:3000/api", "http://127.0.0.1:4320/v1/forward", "http://8.8.8.8/v1"]) {
      const response = await local({ target });
      assert.equal(response.status, 403, target);
      assert.equal((await response.json()).error, "forbidden_target");
    }
    assert.equal((await local({ target: "http://gw:11434/v1/models" })).status, 200);
    assert.equal((await local({ target: "http://gw:11434/v1/models", secret: "cd".repeat(32) })).status, 401);
    assert.equal((await local({ target: "http://gw:11434/v1/models", method: "DELETE" })).status, 403);
    assert.equal(http.seen.length, 1, "refused requests never reach a server");
  });
});
