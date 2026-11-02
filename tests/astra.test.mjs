import assert from "node:assert/strict";
import test from "node:test";

const UUID = "11111111-1111-4111-8111-111111111111";
const unwrap = (module) => module.default ?? module;

test("TASK-051: Astra Mode records an auto-allowed decision without a card or a wait", async () => {
  const { createApprovalGate } = unwrap(await import("../lib/approvals/gate.ts"));
  const rows = [];
  const cards = [];
  const database = {
    insert: () => ({ values: async (value) => { rows.push(value); } }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
  };
  const gate = createApprovalGate({
    database, ownerId: "owner", postCard: async (card) => { cards.push(card); },
    setAttention: async () => { throw new Error("Astra Mode must not set attention"); },
  });
  const result = await gate.request({
    agentId: "agent", runId: null, actionClass: "download", site: "a.example", controlName: "Download PDF", astra: true,
  });
  assert.deepEqual({ decision: result.decision, waitedMs: result.waitedMs, reason: result.reason }, { decision: "allow", waitedMs: 0, reason: "astra" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "auto_allowed");
  assert.ok(rows[0].decidedAt instanceof Date);
  assert.deepEqual(cards, []);
});

test("TASK-051: without Astra Mode the gate still asks the owner", async () => {
  const { createApprovalGate } = unwrap(await import("../lib/approvals/gate.ts"));
  const rows = [];
  const cards = [];
  let attention = 0;
  const database = {
    insert: () => ({ values: async (value) => { rows.push(value); } }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
  };
  const gate = createApprovalGate({
    database, ownerId: "owner", waitMs: 5,
    postCard: async (card) => { cards.push(card); },
    setAttention: async () => { attention += 1; },
    clearAttention: async () => { attention -= 1; },
  });
  const result = await gate.request({
    agentId: "agent", runId: null, actionClass: "download", site: "a.example", controlName: "Download PDF",
  });
  assert.equal(result.decision, "deny");
  assert.equal(result.reason, "timeout");
  assert.equal(rows[0].state, "pending");
  assert.equal(cards[0].type, "approval");
  assert.equal(attention, 0);
});

test("TASK-051: the Astra route exposes only an authenticated POST", async () => {
  const route = unwrap(await import("../app/api/agents/[agentId]/astra/route.ts"));
  assert.equal(typeof route.POST, "function");
  assert.equal(route.GET, undefined);
  const response = await route.POST(new Request(`http://127.0.0.1:3000/api/agents/${UUID}/astra`, {
    method: "POST", headers: { Origin: "http://127.0.0.1:3000" },
  }), { params: Promise.resolve({ agentId: UUID }) });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
  assert.equal(response.headers.get("cache-control"), "no-store");
});
