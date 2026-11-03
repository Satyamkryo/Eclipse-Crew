import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import {
  MAX_ACTIVE, MAX_BODY_BYTES, MAX_RESPONSE_BYTES, REDACTION, createProxy, isBlockedAddress, parseTarget,
} from "../docker/egress/proxy.mjs";
import { createProxyTransport } from "../lib/providers/proxy-transport.ts";
import { proxyTransportFor } from "../lib/models/transport.ts";
import { testSavedRole } from "../lib/models/testing.ts";
import { encryptSecret } from "../lib/security/encryption.ts";

const SECRET = "ab".repeat(32);
const KEY = "sk-test-CANARY-1234567890abcdef";
const PUBLIC = [{ address: "93.184.216.34", family: 4 }];

// Fake upstream: records the request options and lets each test decide the answer.
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
        response.statusCode = 200; response.headers = {};
        Promise.resolve(handler(record, response)).then((outcome) => {
          if (outcome === "hang") return;
          onResponse(response); next();
        });
      },
    });
    request.setTimeout = () => request; request.destroy = () => request.emit("close");
    return request;
  };
  upstream.seen = seen;
  return upstream;
}
const reply = (status, body, headers = {}) => (record, response) => {
  response.statusCode = status; response.headers = { "content-type": "application/json", ...headers };
  setImmediate(() => { response.end(body); });
};

async function withProxy(options, fn) {
  const logs = [];
  const server = createProxy({ secret: SECRET, resolve: async () => PUBLIC, log: (event) => logs.push(event), ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn({ base, logs, forward: (init = {}) => forward(base, init) }); }
  finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); }
}
function forward(base, { secret = SECRET, target = "https://api.meta.ai/v1/models", method = "GET", credential = KEY, body, headers = {} } = {}) {
  const h = { "X-Eclipse-Target": target, "X-Eclipse-Method": method, ...headers };
  if (secret !== null) h.Authorization = `Bearer ${secret}`;
  if (credential !== null) h["X-Eclipse-Credential"] = credential;
  return fetch(`${base}/v1/forward`, { method: "POST", headers: h, body });
}
const code = async (response) => (await response.json()).error;

test("address blocklist covers private, loopback, link-local, metadata, CGNAT, mapped and documentation ranges", () => {
  for (const address of ["0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "192.0.2.1", "198.18.0.1", "224.0.0.1", "255.255.255.255", "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "fe80::1", "fc00::1", "fd00:ec2::254",
    "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1", "ff02::1", "not-an-ip", ""]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111", "2a00:1450:4001:81b::200e"]) {
    assert.equal(isBlockedAddress(address), false, address);
  }
});

test("targets must be public https hostnames on port 443 without credentials", () => {
  assert.deepEqual(parseTarget("https://api.meta.ai/v1/models?x=1"), { host: "api.meta.ai", path: "/v1/models?x=1" });
  assert.deepEqual(parseTarget("https://API.OpenAI.com:443/v1/chat"), { host: "api.openai.com", path: "/v1/chat" });
  for (const bad of ["http://api.meta.ai/", "https://127.0.0.1/", "https://[::1]/", "https://169.254.169.254/latest", "https://localhost/",
    "https://internal/", "https://api.meta.ai:8443/", "https://user:pw@api.meta.ai/", "https://api.meta.ai/#frag", "ftp://api.meta.ai/",
    "https://api.meta.ai\\@evil.example/", "https://-bad.example.com/", "", "not a url", `https://api.meta.ai/${"a".repeat(2100)}`]) {
    assert.throws(() => parseTarget(bad), (error) => error.code === "forbidden_target", bad);
  }
});

test("forwarding injects the key once, keeps only safe headers and pins the checked address", async () => {
  const upstream = fakeUpstream(reply(200, JSON.stringify({ data: [{ id: "m1" }] }), { "set-cookie": "a=b", "x-secret": "no" }));
  await withProxy({ upstream }, async ({ forward: send, logs }) => {
    const response = await send({ method: "POST", body: JSON.stringify({ q: 1 }), headers: { "Content-Type": "application/json", Accept: "application/json", Cookie: "session=1", "X-Forwarded-For": "1.2.3.4", Origin: "http://x" } });
    assert.equal(response.status, 200); assert.equal(response.headers.get("x-eclipse-proxy"), "ok");
    assert.equal(response.headers.get("set-cookie"), null); assert.equal(response.headers.get("x-secret"), null);
    assert.deepEqual(await response.json(), { data: [{ id: "m1" }] });
    const [call] = upstream.seen;
    assert.deepEqual([call.options.host, call.options.port, call.options.method, call.options.path, call.options.servername], ["api.meta.ai", 443, "POST", "/v1/models", "api.meta.ai"]);
    assert.deepEqual(Object.keys(call.options.headers).sort(), ["accept", "accept-encoding", "authorization", "content-length", "content-type", "user-agent"]);
    assert.equal(call.options.headers.authorization, `Bearer ${KEY}`);
    assert.equal(call.body().toString(), JSON.stringify({ q: 1 }));
    let pinned; call.options.lookup("api.meta.ai", {}, (error, address, family) => { pinned = [error, address, family]; });
    assert.deepEqual(pinned, [null, "93.184.216.34", 4]);
    let pinnedAll; call.options.lookup("api.meta.ai", { all: true }, (error, list) => { pinnedAll = [error, list]; });
    assert.deepEqual(pinnedAll, [null, [{ address: "93.184.216.34", family: 4 }]]);
    assert.ok(!JSON.stringify(logs).includes(KEY));
  });
});

test("an upstream error status stays distinguishable from a proxy refusal", async () => {
  const upstream = fakeUpstream(reply(401, JSON.stringify({ error: "bad key" })));
  await withProxy({ upstream }, async ({ forward: send }) => {
    const fromUpstream = await send();
    assert.equal(fromUpstream.status, 401); assert.equal(fromUpstream.headers.get("x-eclipse-proxy"), "ok");
    const fromProxy = await send({ secret: "cd".repeat(32) });
    assert.equal(fromProxy.status, 401); assert.equal(fromProxy.headers.get("x-eclipse-proxy"), "error"); assert.equal(await code(fromProxy), "unauthorized");
  });
});

test("requests that fail authentication or validation never reach the upstream", async () => {
  const upstream = fakeUpstream(reply(200, "{}"));
  await withProxy({ upstream }, async ({ base, forward: send }) => {
    assert.equal((await send({ secret: null })).status, 401);
    assert.equal((await send({ secret: "short" })).status, 401);
    assert.equal((await fetch(`${base}/v1/forward`, { method: "POST", headers: { Authorization: `Basic ${SECRET}` } })).status, 401);
    assert.equal((await fetch(`${base}/v1/forward`, { headers: { Authorization: `Bearer ${SECRET}` } })).status, 404);
    assert.equal((await fetch(`${base}/other`, { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } })).status, 404);
    for (const target of ["http://api.meta.ai/", "https://169.254.169.254/", "https://127.0.0.1/", "https://api.meta.ai:8080/", "https://localhost/"]) {
      const response = await send({ target }); assert.equal(response.status, 403, target); assert.equal(await code(response), "forbidden_target");
    }
    assert.equal((await send({ method: "DELETE" })).status, 403);
    assert.equal((await send({ credential: "has space in it" })).status, 400);
    assert.equal((await send({ credential: "short" })).status, 400);
    assert.equal((await send({ method: "GET", body: "x" })).status, 400);
    assert.equal((await send({ method: "POST", body: Buffer.alloc(MAX_BODY_BYTES + 1) })).status, 413);
    assert.equal((await send({ method: "POST", body: "{}", headers: { "Content-Type": "text/html<script>" } })).status, 400);
    assert.equal(upstream.seen.length, 0);
  });
});

test("a hostname that resolves to any private or metadata address is refused", async () => {
  for (const addresses of [[{ address: "10.0.0.5", family: 4 }], [{ address: "93.184.216.34", family: 4 }, { address: "169.254.169.254", family: 4 }],
    [{ address: "::1", family: 6 }], [{ address: "::ffff:10.0.0.1", family: 6 }], []]) {
    const upstream = fakeUpstream(reply(200, "{}"));
    await withProxy({ upstream, resolve: async () => addresses }, async ({ forward: send }) => {
      const response = await send(); assert.equal(response.status, 403); assert.equal(upstream.seen.length, 0);
    });
  }
  const upstream = fakeUpstream(reply(200, "{}"));
  await withProxy({ upstream, resolve: async () => { throw new Error("nxdomain"); } }, async ({ forward: send }) => {
    assert.equal(await code(await send()), "upstream_error"); assert.equal(upstream.seen.length, 0);
  });
});

test("a reflected key is redacted and credentials never reach responses or logs", async () => {
  const upstream = fakeUpstream(reply(400, JSON.stringify({ error: `invalid key ${KEY}`, again: KEY })));
  await withProxy({ upstream }, async ({ forward: send, logs }) => {
    const text = await (await send()).text();
    assert.ok(!text.includes(KEY)); assert.ok(text.includes(REDACTION));
    assert.ok(!JSON.stringify(logs).includes(KEY));
  });
});

test("slow, oversized and unreachable upstreams fail with fixed codes; concurrency is bounded", async () => {
  await withProxy({ upstream: fakeUpstream(() => "hang"), timeoutMs: 80 }, async ({ forward: send }) => {
    const response = await send(); assert.equal(response.status, 504); assert.equal(await code(response), "upstream_timeout");
  });
  const big = fakeUpstream((record, response) => { response.statusCode = 200; response.headers = {}; setImmediate(() => response.write(Buffer.alloc(MAX_RESPONSE_BYTES + 1))); });
  await withProxy({ upstream: big }, async ({ forward: send }) => {
    const response = await send(); assert.equal(response.status, 502); assert.equal(await code(response), "response_too_large");
  });
  const inner = fakeUpstream(() => "hang");
  await withProxy({ upstream: inner, timeoutMs: 3000 }, async ({ forward: send }) => {
    const pending = Array.from({ length: MAX_ACTIVE }, () => send().catch(() => null));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const extra = await send(); assert.equal(extra.status, 503); assert.equal(await code(extra), "busy");
    assert.equal(inner.seen.length, MAX_ACTIVE);
    await Promise.all(pending);
  });
});

test("without a valid secret the proxy is unhealthy and refuses every forward", async () => {
  for (const secret of [undefined, "", "abc", "AB".repeat(32)]) {
    const upstream = fakeUpstream(reply(200, "{}"));
    const server = createProxy({ secret, resolve: async () => PUBLIC, upstream });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.equal((await fetch(`${base}/healthz`)).status, 503);
      assert.equal((await forward(base, { secret: secret ?? "x" })).status, 503);
      assert.equal(upstream.seen.length, 0);
    } finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); }
  }
  await withProxy({}, async ({ base }) => assert.equal((await fetch(`${base}/healthz`)).status, 200));
});

test("the app transport sends only the target, method, safe headers and key to the proxy", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response("{}", { headers: { "x-eclipse-proxy": "ok" } }); };
  const transport = createProxyTransport({ credential: KEY, secret: SECRET, baseUrl: "http://proxy.test:4320", fetchImpl });
  const controller = new AbortController();
  await transport("https://api.meta.ai/v1/responses", { method: "post", body: "{\"a\":1}", signal: controller.signal,
    headers: { "Content-Type": "application/json", Authorization: "Bearer attacker", Cookie: "x=1", "X-Eclipse-Credential": "attacker-credential" } });
  const [{ url, init }] = calls;
  assert.equal(url, "http://proxy.test:4320/v1/forward"); assert.equal(init.method, "POST"); assert.equal(init.body, "{\"a\":1}");
  assert.equal(init.redirect, "error"); assert.equal(init.signal, controller.signal);
  assert.deepEqual(init.headers, { Authorization: `Bearer ${SECRET}`, "X-Eclipse-Target": "https://api.meta.ai/v1/responses",
    "X-Eclipse-Method": "POST", "X-Eclipse-Credential": KEY, "content-type": "application/json" });
  assert.ok(!url.includes(KEY) && !String(init.body).includes(KEY));
  await transport("https://api.meta.ai/v1/models", {});
  assert.equal(calls[1].init.body, undefined); assert.equal(calls[1].init.headers["X-Eclipse-Method"], "GET");
  for (const [target, init] of [["http://api.meta.ai/", {}], ["https://u:p@api.meta.ai/", {}], ["https://api.meta.ai/", { method: "DELETE" }],
    ["https://api.meta.ai/", { method: "POST", body: new Uint8Array(2) }], ["not a url", {}]]) {
    await assert.rejects(transport(target, init), undefined, target);
  }
  assert.equal(calls.length, 2);
  const failing = createProxyTransport({ credential: KEY, secret: SECRET, fetchImpl: async () => new Response("{}", { status: 401 }) });
  await assert.rejects(failing("https://api.meta.ai/v1/models", {}), /egress_proxy_error/);
  assert.throws(() => createProxyTransport({ credential: KEY, secret: "short" }));
  assert.throws(() => createProxyTransport({ credential: "bad key", secret: SECRET }));
});

test("saved provider keys are decrypted only to build the transport; unusable keys give no transport", () => {
  const previous = { key: process.env.ENCRYPTION_KEY, secret: process.env.EGRESS_PROXY_SECRET };
  process.env.ENCRYPTION_KEY = "cd".repeat(32); process.env.EGRESS_PROXY_SECRET = SECRET;
  try {
    const provider = { id: "p", kind: "meta", baseUrl: null, keyHint: "…cdef", encryptedKey: encryptSecret(KEY) };
    assert.equal(typeof proxyTransportFor(provider), "function");
    assert.equal(proxyTransportFor({ ...provider, encryptedKey: null }), null);
    assert.equal(proxyTransportFor({ ...provider, encryptedKey: `${provider.encryptedKey.slice(0, -2)}AA` }), null);
    assert.equal(proxyTransportFor({ ...provider, encryptedKey: "v1.garbage" }), null);
    delete process.env.EGRESS_PROXY_SECRET;
    assert.equal(proxyTransportFor(provider), null);
  } finally {
    for (const [name, value] of [["ENCRYPTION_KEY", previous.key], ["EGRESS_PROXY_SECRET", previous.secret]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test("Test lists models through the proxy transport and still fails closed without one", async () => {
  const provider = { id: "p", kind: "meta", baseUrl: null, keyHint: null, encryptedKey: "stored" };
  const store = { load: async () => ({ main: { role: "main", providerId: "p", provider, model: "muse-spark-1.3", useMainKey: false, mode: "active" }, sam: null }) };
  const seen = [];
  const transport = async (url, init) => { seen.push([url, init.method]); return Response.json({ data: [{ id: "muse-spark-1.3" }] }); };
  const result = await testSavedRole(store, "owner", "main", undefined, (stored) => { assert.equal(stored, provider); return transport; });
  assert.deepEqual(result.models.map((m) => m.id), ["muse-spark-1.3"]); assert.equal(seen.length, 1);
  await assert.rejects(testSavedRole(store, "owner", "main", undefined, () => null), (error) => error.code === "authenticated_transport_unavailable" && error.status === 503);
  await assert.rejects(testSavedRole(store, "owner", "main"), (error) => error.code === "authenticated_transport_unavailable");
  assert.equal(seen.length, 1);
});

test("dedicated ASR builds fixed multipart and forbids target overrides", async () => {
  const wav=Buffer.alloc(48044); wav.write("RIFF");wav.writeUInt32LE(wav.length-8,4);wav.write("WAVEfmt ",8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write("data",36);wav.writeUInt32LE(48000,40);
  const upstream=fakeUpstream(reply(200,'{"audioDurationMs":1000,"turns":[]}'));
  await withProxy({upstream},async({base})=>{
    const headers={Authorization:`Bearer ${SECRET}`,"X-Eclipse-Credential":KEY,"Content-Type":"audio/wav"};
    const response=await fetch(`${base}/v1/teach-asr`,{method:"POST",headers,body:wav});assert.equal(response.status,200);
    const request=upstream.seen[0];assert.equal(request.options.host,"api.meta.ai");assert.equal(request.options.path,"/v1/asr/transcribe");assert.equal(request.options.headers.authorization,`Bearer ${KEY}`);assert.match(request.body().toString(),/"mode":"ENDPOINTING"/);
    const denied=await fetch(`${base}/v1/teach-asr`,{method:"POST",headers:{...headers,"X-Eclipse-Target":"https://example.com"},body:wav});assert.equal(denied.status,400);assert.equal(upstream.seen.length,1);
  });
});

test("device sign-in calls only the fixed GitHub endpoints and refuses any other target", async () => {
  const deviceReply = JSON.stringify({ device_code: "device-code-0123456789", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
  const tokenReply = JSON.stringify({ access_token: "ghu_ACCESS_0123456789", token_type: "bearer", scope: "", refresh_token: "ghr_REFRESH_0123456789", expires_in: 28800, refresh_token_expires_in: 15552000 });
  const upstream = fakeUpstream((record, response) => {
    const body = /client_id=([^&]+)/.exec(record.body().toString())?.[1] ?? "";
    const payload = record.options.path === "/login/device/code" ? deviceReply : tokenReply;
    response.statusCode = 200; response.headers = { "content-type": "application/json" };
    setImmediate(() => response.end(payload));
    assert.equal(body, "Iv1.test");
  });
  await withProxy({ upstream }, async ({ base, logs }) => {
    const post = (body) => fetch(`${base}/v1/github-device`, {
      method: "POST", headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const started = await post({ operation: "code", clientId: "Iv1.test" });
    assert.equal(started.status, 200);
    assert.deepEqual(await started.json(), JSON.parse(deviceReply));
    const first = upstream.seen[0];
    assert.equal(first.options.host, "github.com"); assert.equal(first.options.path, "/login/device/code");
    assert.equal(first.options.method, "POST");
    assert.equal(first.options.headers["content-type"], "application/x-www-form-urlencoded");
    assert.equal(first.options.headers["content-length"], String(first.body().length));

    const token = await post({ operation: "token", clientId: "Iv1.test", deviceCode: "device-code-0123456789" });
    assert.equal(token.status, 200);
    assert.equal((await token.json()).access_token, "ghu_ACCESS_0123456789");
    const second = upstream.seen[1];
    assert.equal(second.options.path, "/login/oauth/access_token");
    assert.match(second.body().toString(), /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code/);
    assert.equal(JSON.stringify(logs).includes("ghu_ACCESS"), false);
    assert.equal(JSON.stringify(logs).includes("ghr_REFRESH"), false);

    const refresh = await post({ operation: "token", clientId: "Iv1.test", refreshToken: "ghr_REFRESH_0123456789" });
    assert.equal(refresh.status, 200);
    assert.match(upstream.seen[2].body().toString(), /grant_type=refresh_token/);

    for (const bad of [
      { operation: "code", clientId: "Iv1.test", target: "https://example.com" },
      { operation: "token", clientId: "Iv1.test" },
      { operation: "token", clientId: "Iv1.test", deviceCode: "a", refreshToken: "b" },
      { operation: "other", clientId: "Iv1.test" },
      { operation: "code", clientId: "bad id" },
      { operation: "code" },
    ]) {
      const response = await post(bad);
      assert.equal(response.status, 400, JSON.stringify(bad));
    }
    const wrongMethod = await fetch(`${base}/v1/github-device`, { headers: { Authorization: `Bearer ${SECRET}` } });
    assert.equal(wrongMethod.status, 404);
    assert.equal(upstream.seen.length, 3);
  });
});
