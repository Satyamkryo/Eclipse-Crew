import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import pg from "pg";
const unwrap = (module) => module.default ?? module;

const csrf = unwrap(await import("../lib/auth/csrf.ts"));
const password = unwrap(await import("../lib/auth/password.ts"));
const rateLimit = unwrap(await import("../lib/auth/rate-limit.ts"));

test("argon2id hashing verifies only the original password", async () => {
  const hash = await password.hashPassword("synthetic-password-123");
  assert.match(hash, /^\$argon2id\$/);
  assert.equal(await password.verifyPassword(hash, "synthetic-password-123"), true);
  assert.equal(await password.verifyPassword(hash, "wrong"), false);
});
test("CSRF requires the actual session token, not only matching syntax", () => {
  const expected = csrf.generateCsrfToken();
  assert.match(expected, /^[0-9a-f]{64}$/);
  assert.equal(csrf.validateCsrfToken(expected, expected), true);
  for (const token of [undefined, "invalid", "0".repeat(64), expected.toUpperCase()])
    assert.equal(csrf.validateCsrfToken(token, expected), false);
});
test("single-owner lockout cannot be bypassed by changing claimed IP headers", async () => {
  const { POST } = unwrap(await import("../app/api/auth/login/route.ts"));
  const origin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = "http://127.0.0.1:3000";
  rateLimit.resetRateLimit();
  try {
    for (let i = 0; i < 5; i++) {
      const response = await POST(new Request("http://127.0.0.1:3000/api/auth/login", { method: "POST",
        headers: { Origin: process.env.APP_ORIGIN, "Content-Type": "application/json", "X-Forwarded-For": `192.0.2.${i}` }, body: "{}" }));
      assert.equal(response.status, 401);
    }
    const response = await POST(new Request("http://127.0.0.1:3000/api/auth/login", { method: "POST",
      headers: { Origin: process.env.APP_ORIGIN, "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.99", "X-Real-IP": "198.51.100.100" }, body: "{}" }));
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get("retry-after")) > 0);
  } finally { rateLimit.resetRateLimit(); if (origin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = origin; }
});
test("actual Drizzle auth guards enforce expiry/revocation/CSRF and reject owner overrides before dispatch", async () => {
  const originalQuery = pg.Pool.prototype.query;
  const originalUrl = process.env.DATABASE_URL;
  const originalOrigin = process.env.APP_ORIGIN;
  const originalFetch = globalThis.fetch;
  const ownerId = "09d2abec-a9b9-438a-afed-29662161148c";
  const sessionId = "c039e90d-7c75-4cb0-a42c-f5c76af3160d";
  const token = "a".repeat(64);
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const csrfToken = "b".repeat(64);
  let expiry = Date.now() + 60000;
  let revoked = false;
  let calls = 0;
  let sessionQueries = 0;
  process.env.DATABASE_URL = "postgresql://eclipse_app:SYNTHETIC_TEST_ONLY@127.0.0.1/eclipse";
  process.env.APP_ORIGIN = "http://127.0.0.1:3000";
  pg.Pool.prototype.query = async function (query, params) {
    const sql = typeof query === "string" ? query : query.text;
    if (sql.includes("current_user AS current_user")) return { rows: [{ current_user: "eclipse_app", session_user: "eclipse_app" }] };
    if (sql.includes('"agent_policies"')) return { rows: [[[], ["example.com"], [], ["agent"]]] };
    if (sql.includes('"agents"')) return { rows: [[ownerId, "Test agent", "Test role", "Test persona", "active", 100, 1000, new Date(), new Date()]] };
    assert.match(sql, /inner join "owner"/);
    assert.match(sql, /"expires_at" > \$2/);
    sessionQueries++;
    const values = params ?? query.values;
    return { rows: !revoked && values[0] === tokenHash && new Date(values[1]).getTime() < expiry ? [[sessionId, ownerId, csrfToken]] : [] };
  };
  globalThis.fetch = async () => { calls++; throw new Error("Unexpected upstream call"); };
  try {
    const session = unwrap(await import("../lib/auth/session.ts"));
    const request = unwrap(await import("../lib/auth/request.ts"));
    const make = (headers = {}, body = {}) => new Request("http://127.0.0.1:3000/api/desktop/09d2abec-a9b9-438a-afed-29662161148c/input", {
      method: "POST", headers: { Cookie: `eclipse_session=${token}`, Origin: process.env.APP_ORIGIN, "x-csrf-token": csrfToken,
        "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    const authenticated = await request.requireOwnerRequest(make(), { mutation: true });
    assert.equal(authenticated.ownerId, ownerId);
    assert.equal(authenticated.sessionId, sessionId);
    assert.match(authenticated.sessionRef, /^[0-9a-f]{64}$/);
    assert.notEqual(authenticated.sessionRef, token);
    assert.equal(session.sessionTokenFromRequest(make({ Cookie: `eclipse_session=${token}; eclipse_session=${token}` })), undefined);
    for (const headers of [{ Cookie: "eclipse_session=" + "c".repeat(64) }, { "x-csrf-token": "d".repeat(64) }, { Origin: "https://127.0.0.1:3000" }, { Origin: "null" }, { Origin: "http://127.0.0.1:3001" }])
      await assert.rejects(request.requireOwnerRequest(make(headers), { mutation: true }), (error) => [401,403].includes(error.status));
    await assert.rejects(request.requireOwnerRequest(new Request(make(), { headers: { Cookie: `eclipse_session=${token}`, "x-csrf-token": csrfToken } }), { mutation: true }), { status: 403 });
    expiry = Date.now() - 1;
    assert.equal(await session.validateSessionToken(token), null);
    expiry = Date.now() + 60000; revoked = true;
    assert.equal(await session.validateSessionToken(token), null);
    revoked = false;
    const { POST } = unwrap(await import("../app/api/desktop/[agentId]/input/route.ts"));
    const valid = { operation: "input.type", text: "hello", generation: crypto.randomUUID(), connectionId: crypto.randomUUID(), leaseId: crypto.randomUUID() };
    for (const extra of [{ ownerId: crypto.randomUUID() }, { requestId: crypto.randomUUID() }, { sessionRef: "e".repeat(64) }, { x: 12 }, { agentId: crypto.randomUUID() }]) {
      const response = await POST(make({ "x-owner-id": crypto.randomUUID() }, { ...valid, ...extra }), { params: Promise.resolve({ agentId: ownerId }) });
      assert.equal(response.status, 400);
    }
    const unauthenticated = await POST(make({ Cookie: "" }, valid), { params: Promise.resolve({ agentId: ownerId }) });
    assert.equal(unauthenticated.status, 401);
    assert.equal(calls, 0);
    const secret = process.env.DESKTOP_CONTROL_SECRET;
    process.env.DESKTOP_CONTROL_SECRET = "f".repeat(64);
    const requests = [];
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body, headers: options.headers });
      return Response.json({ outcome: "ok", result: body.operation === "session.status" ?
        { agentId: ownerId, state: "running", generation: valid.generation, display: 100, vncPort: 5901, vncReady: true } : { ok: true } });
    };
    try {
      const response = await POST(make({ "x-owner-id": crypto.randomUUID() }, valid), { params: Promise.resolve({ agentId: ownerId }) });
      assert.equal(response.status, 200);
      assert.equal(requests[0].body.ownerId, ownerId);
      assert.equal(requests[0].body.sessionRef, authenticated.sessionRef);
      assert.equal(requests[0].body.generation, valid.generation);
      assert.equal(requests[0].body.connectionId, valid.connectionId);
      assert.equal(requests[0].body.leaseId, valid.leaseId);
      assert.match(requests[0].body.requestId, /^[0-9a-f-]{36}$/);
      assert.equal(requests[0].headers.Authorization, "Bearer " + "f".repeat(64));
      const stream = unwrap(await import("../app/api/desktop/[agentId]/stream/route.ts"));
      const probe = new Request(`http://127.0.0.1:3000/api/desktop/${ownerId}/stream?connectionId=${valid.connectionId}`, { headers: { Cookie: `eclipse_session=${token}` } });
      const ready = await stream.GET(probe, { params: Promise.resolve({ agentId: ownerId }) });
      assert.equal(ready.status, 200);
      assert.deepEqual(await ready.json(), { agentId: ownerId, ownerId, sessionRef: authenticated.sessionRef, generation: valid.generation, state: "running" });
      const malformed = await stream.GET(new Request(probe.url + "&ownerId=" + ownerId, probe), { params: Promise.resolve({ agentId: ownerId }) });
      assert.equal(malformed.status, 400);
      assert.equal(requests.length, 2);
    } finally { if (secret === undefined) delete process.env.DESKTOP_CONTROL_SECRET; else process.env.DESKTOP_CONTROL_SECRET = secret; }
    const { proxy } = unwrap(await import("../proxy.ts"));
    const { NextRequest } = unwrap(await import("next/server.js"));
    const blocked = await proxy(new NextRequest("http://127.0.0.1:3000/", { headers: { Cookie: "eclipse_session=" + "c".repeat(64) } }));
    assert.equal(blocked.status, 307);
    assert.equal(blocked.headers.get("location"), "http://127.0.0.1:3000/login");
    assert.equal(blocked.headers.get("cache-control"), "private, no-store");
    assert.equal(blocked.headers.get("x-content-type-options"), "nosniff");
    assert.match(blocked.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.ok(sessionQueries >= 12);
    process.env.APP_ORIGIN = "https://crew.example.test";
    assert.deepEqual({ name: session.sessionCookieOptions().name, secure: session.sessionCookieOptions().secure }, { name: "__Host-eclipse_session", secure: true });
    process.env.APP_ORIGIN = "http://127.0.0.1:3000";
    assert.deepEqual({ name: session.sessionCookieOptions().name, secure: session.sessionCookieOptions().secure }, { name: "eclipse_session", secure: false });
  } finally {
    pg.Pool.prototype.query = originalQuery;
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalUrl;
    if (originalOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = originalOrigin;
  }
});
test("bounded JSON rejects oversized streams and unauthenticated origins", async () => {
  const request = unwrap(await import("../lib/auth/request.ts"));
  for (const origin of [undefined, "null", "http://evil.test", "http://127.0.0.1:3000/path", "http://127.0.0.1:3000/"]) {
    const headers = origin === undefined ? {} : { Origin: origin };
    assert.throws(() => request.requireTrustedOrigin(new Request("http://127.0.0.1:3000", { headers })), { status: 403 });
  }
  await assert.rejects(request.readBoundedJson(new Request("http://127.0.0.1:3000", { method: "POST", headers: { "Content-Type": "application/json" }, body: '"' + "x".repeat(100) + '"' }), 32), { status: 413 });
  await assert.rejects(request.readBoundedJson(new Request("http://127.0.0.1:3000", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })), { status: 415 });
});
test("desktop client rejects metadata overrides, malformed results, oversized responses and stalled bodies", async () => {
  const client = unwrap(await import("../lib/desktop/client.ts"));
  const originalFetch = globalThis.fetch;
  const originalSecret = process.env.DESKTOP_CONTROL_SECRET;
  process.env.DESKTOP_CONTROL_SECRET = "f".repeat(64);
  const agentId = crypto.randomUUID(), ownerId = crypto.randomUUID(), generation = crypto.randomUUID();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ outcome: "ok", result: { ok: true } }); };
  try {
    for (const params of [{ ownerId }, { agentId }, { requestId: crypto.randomUUID() }, { generation }, { unrelated: "value" }])
      await assert.rejects(client.desktopCommand(agentId, ownerId, generation, "browser.pages", params));
    assert.equal(calls, 0);
    globalThis.fetch = async () => Response.json({ outcome: "ok", result: { agentId, state: "running", generation: 0 } });
    await assert.rejects(client.desktopSession(agentId, ownerId, "session.status"));
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(6 * 1024 * 1024 + 1)); controller.close(); } }));
    await assert.rejects(client.desktopSession(agentId, ownerId, "session.status"), /response_body_too_large/);
    let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    await assert.rejects(client.desktopSession(agentId, ownerId, "session.status"), /desktop_timeout/);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.DESKTOP_CONTROL_SECRET; else process.env.DESKTOP_CONTROL_SECRET = originalSecret;
  }
});
