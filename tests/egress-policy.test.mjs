import assert from "node:assert/strict";
import test from "node:test";

import { pushAgentPolicy } from "../lib/egress/sync.ts";

const SECRET = "ab".repeat(32);
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("policy pushes use the app secret, a bounded JSON body and the private proxy URL", async () => {
  const calls = [];
  const result = await pushAgentPolicy({ agentId: AGENT, domains: ["example.com"], blocked: false }, {
    secret: SECRET,
    baseUrl: "http://proxy.test:4320",
    timeoutMs: 2_000,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  assert.equal(result, true);
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, "http://proxy.test:4320/v1/policy");
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.equal(init.cache, "no-store");
  assert.equal(init.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(init.body), { agentId: AGENT, domains: ["example.com"], blocked: false });
  assert.ok(!init.body.includes(SECRET));
});

test("a proxy rejection, network failure or missing secret is a soft failure", async () => {
  const rejected = await pushAgentPolicy({ agentId: AGENT, domains: [], blocked: true }, {
    secret: SECRET, fetchImpl: async () => new Response("{}", { status: 503 }),
  });
  assert.equal(rejected, false);

  const offline = await pushAgentPolicy({ agentId: AGENT, domains: ["example.com"], blocked: false }, {
    secret: SECRET, fetchImpl: async () => { throw new Error("offline"); },
  });
  assert.equal(offline, false);

  let called = false;
  const unconfigured = await pushAgentPolicy({ agentId: AGENT, domains: ["example.com"], blocked: false }, {
    secret: "short", fetchImpl: async () => { called = true; return new Response("{}", { status: 200 }); },
  });
  assert.equal(unconfigured, false);
  assert.equal(called, false);
});

test("blocked pushes carry an empty list and are still well formed", async () => {
  let body;
  const result = await pushAgentPolicy({ agentId: AGENT, domains: [], blocked: true }, {
    secret: SECRET,
    fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return new Response("{}", { status: 200 }); },
  });
  assert.equal(result, true);
  assert.deepEqual(body, { agentId: AGENT, domains: [], blocked: true });
});

test("canary hashes and trip or clearTrip flags ride the same authenticated push", async () => {
  const hash = "a".repeat(64);
  let body;
  const push = (policy) => pushAgentPolicy(policy, {
    secret: SECRET,
    fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return new Response("{}", { status: 200 }); },
  });
  await push({ agentId: AGENT, domains: ["example.com"], blocked: true, canaryHashes: [hash], trip: true });
  assert.deepEqual(body, { agentId: AGENT, domains: ["example.com"], blocked: true, canaryHashes: [hash], trip: true });
  await push({ agentId: AGENT, domains: ["example.com"], blocked: false, canaryHashes: [hash], clearTrip: true });
  assert.deepEqual(body, { agentId: AGENT, domains: ["example.com"], blocked: false, canaryHashes: [hash], clearTrip: true });
  assert.equal(JSON.stringify(body).includes("ecx-"), false);
});
