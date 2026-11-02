import assert from "node:assert/strict";
import test from "node:test";

import { haltAgent, resumeCrew, stopCrew } from "../lib/security/halt.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

function ports(log = [], { hang = null, fail = null, stop = true } = {}) {
  const step = (name) => async () => {
    log.push(name);
    if (hang === name) await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (fail === name) throw new Error(name);
    return name === "stop_session" ? stop : undefined;
  };
  return {
    latchEgress: step("latch_egress"),
    cancelRuns: step("cancel_runs"),
    markPaused: step("pause"),
    stopSession: step("stop_session"),
    postCard: async (_owner, _agent, text) => { log.push(`card:${text}`); },
  };
}

test("haltAgent runs every step once in the fixed order and reports success", async () => {
  const log = [];
  const result = await haltAgent(ports(log), { ownerId: OWNER, agentId: AGENT });
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map((step) => step.step), ["latch_egress", "cancel_runs", "pause", "stop_session", "card"]);
  assert.ok(result.steps.every((step) => step.ok));
  assert.deepEqual(log.slice(0, 4), ["latch_egress", "cancel_runs", "pause", "stop_session"]);
  assert.match(log[4], /^card:Agent stopped\./);
});

test("a hanging proxy or desktop never blocks the pause or the answer", async () => {
  const log = [];
  const started = Date.now();
  const result = await haltAgent(ports(log, { hang: "latch_egress" }), { ownerId: OWNER, agentId: AGENT, budgetMs: 300 });
  assert.ok(Date.now() - started < 1_000);
  assert.deepEqual(result.steps.map((step) => [step.step, step.ok]), [
    ["latch_egress", false], ["cancel_runs", true], ["pause", true], ["stop_session", true], ["card", true],
  ]);
  assert.equal(result.ok, true);
});

test("a failed pause reports ok false but the desktop stop and card still run", async () => {
  const log = [];
  const result = await haltAgent(ports(log, { fail: "pause" }), { ownerId: OWNER, agentId: AGENT });
  assert.equal(result.ok, false);
  assert.deepEqual(result.steps.find((step) => step.step === "pause"), { step: "pause", ok: false });
  assert.ok(log.includes("stop_session"));
  assert.ok(log.some((entry) => entry.startsWith("card:")));
});

test("a desktop that will not stop is named in the card, and a second stop is harmless", async () => {
  const log = [];
  const failing = ports(log, { stop: false });
  const first = await haltAgent(failing, { ownerId: OWNER, agentId: AGENT });
  const second = await haltAgent(failing, { ownerId: OWNER, agentId: AGENT });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.ok(log.some((entry) => entry.includes("The desktop could not be stopped.")));
});

test("stop crew sets the gate first, halts every agent, and one failure does not stop the others", async () => {
  const log = [];
  const agents = ["a0000000-0000-4000-8000-000000000001", "a0000000-0000-4000-8000-000000000002", "a0000000-0000-4000-8000-000000000003"];
  let flag = null;
  const shared = {
    ...ports(log, { fail: "pause" }),
    async setCrewStopped(ownerId, at) { log.push(`flag:${at ? "set" : "clear"}`); flag = at; },
    async listAgentIds() { log.push("list"); return agents; },
  };
  // The failing pause above applies to every agent; every agent must still reach its card.
  const result = await stopCrew(shared, OWNER, () => new Date("2026-11-02T12:00:00.000Z"));
  assert.equal(result.ok, true);
  assert.ok(flag instanceof Date);
  assert.deepEqual(result.agents.map((agent) => agent.agentId), agents);
  assert.deepEqual(log.slice(0, 2), ["flag:set", "list"]);
  assert.equal(log.filter((entry) => entry.startsWith("card:")).length, 3);
  assert.ok(result.agents.every((agent) => agent.result.ok === false), "the pause failed for each");
});

test("resume crew clears only the gate and never resumes an agent", async () => {
  const log = [];
  const shared = {
    async setCrewStopped(_owner, at) { log.push(at === null ? "clear" : "set"); },
  };
  await resumeCrew(shared, OWNER);
  assert.deepEqual(log, ["clear"]);
});
