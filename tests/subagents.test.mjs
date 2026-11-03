import assert from "node:assert/strict";
import test from "node:test";
import {
  createSubagentManager, subagentLimits, toolGranted, validateSpawn, SCREENLESS_ACTIONS,
} from "../lib/agent/subagents.ts";

const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };

test("helpers receive 20% of the parent's actual limits", () => {
  assert.deepEqual(subagentLimits({ maxSteps: 60, maxTokens: 400_000, maxWallClockMs: 1_800_000 }),
    { maxSteps: 12, maxTokens: 80_000, maxWallClockMs: 360_000 });
  assert.deepEqual(subagentLimits({ maxSteps: 3, maxTokens: 3, maxWallClockMs: 2_000 }),
    { maxSteps: 1, maxTokens: 1, maxWallClockMs: 1_000 });
});

test("spawn refusals use the fixed codes", () => {
  const parentTools = ["read_document", "search_document", "gmail.*", "gmail_send_email"];
  const ok = { task: "Find the three meetings", tools: ["gmail.send"], parentTools, existingTasks: [], count: 0, allowSpawn: true };
  assert.deepEqual(validateSpawn(ok), { ok: true });
  assert.deepEqual(validateSpawn({ ...ok, tools: [] }), { ok: false, code: "no_tools" });
  assert.deepEqual(validateSpawn({ ...ok, tools: ["billing.list"] }), { ok: false, code: "tool_not_granted" });
  assert.deepEqual(validateSpawn({ ...ok, tools: Array.from({ length: 11 }, () => "read_document") }), { ok: false, code: "tool_not_granted" });
  assert.deepEqual(validateSpawn({ ...ok, existingTasks: ["Find the three meetings"] }), { ok: false, code: "duplicate_task" });
  assert.deepEqual(validateSpawn({ ...ok, count: 3 }), { ok: false, code: "subagent_limit" });
  assert.deepEqual(validateSpawn({ ...ok, allowSpawn: false }), { ok: false, code: "nested_spawn" });
  assert.deepEqual(validateSpawn({ ...ok, task: "x".repeat(1001) }), { ok: false, code: "invalid_task" });
  assert.equal(toolGranted("gmail.send", parentTools), true);
  assert.equal(toolGranted("read_document", parentTools), true);
  assert.equal(toolGranted("slack.post", parentTools), false);
});

test("helpers never get ask_owner, the desktop, memory, handoff or nested spawn", () => {
  for (const forbidden of ["ask_owner", "remember", "handoff", "spawn_subagent", "click", "type", "shell"]) {
    assert.equal(SCREENLESS_ACTIONS.includes(forbidden), false, forbidden);
  }
  assert.ok(SCREENLESS_ACTIONS.includes("finish"));
  assert.ok(SCREENLESS_ACTIONS.includes("get_time"));
});

function manager(runImpl) {
  const builds = [];
  const manager = createSubagentManager({
    run: runImpl,
    buildChild: async (input) => { builds.push(input); return { task: input.task }; },
  });
  return { manager, builds };
}

test("spawns run concurrently, return results as data, and refuse a fourth or duplicate task", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { manager: m, builds } = manager(async () => {
    await gate;
    return { outcome: "finished", steps: [], usage, cardPosted: false, summary: "done" };
  });
  const input = { task: "Read the invoices", tools: ["read_document"], parentStep: 2, limits: subagentLimits({ maxSteps: 60, maxTokens: 400_000, maxWallClockMs: 1_800_000 }), parentTools: ["read_document"], allowSpawn: true };
  assert.deepEqual(m.spawn(input), { ok: true, label: "Helper 1" });
  assert.deepEqual(m.spawn({ ...input, task: "Read the emails" }), { ok: true, label: "Helper 2" });
  assert.deepEqual(m.spawn({ ...input, task: "Read the invoices" }), { ok: false, code: "duplicate_task" });
  assert.deepEqual(m.spawn({ ...input, task: "Read a third" }), { ok: true, label: "Helper 3" });
  assert.deepEqual(m.spawn({ ...input, task: "Read a fourth" }), { ok: false, code: "subagent_limit" });
  assert.equal(m.count(), 3);
  assert.equal(builds.length, 3);
  assert.deepEqual(m.status().map((helper) => helper.state), ["running", "running", "running"]);
  assert.deepEqual(m.results(), []);
  release();
  await m.waitForIdle(1000);
  assert.deepEqual(m.status().map((helper) => helper.state), ["finished", "finished", "finished"]);
  const results = m.results();
  assert.equal(results.length, 3);
  assert.deepEqual(results[0], { label: "Helper 1", task: "Read the invoices", outcome: "finished", summary: "done" });
});

test("cancelling the parent cancels every running helper", async () => {
  const { manager: m } = manager(async (deps) => new Promise((resolve) => {
    deps.signal.addEventListener("abort", () => resolve({ outcome: "aborted", steps: [], usage, cardPosted: false }), { once: true });
  }));
  const input = { task: "Look up the meetings", tools: ["search_history"], parentStep: 1, limits: subagentLimits({ maxSteps: 60, maxTokens: 400_000, maxWallClockMs: 1_800_000 }), parentTools: ["search_history"], allowSpawn: true };
  assert.equal(m.spawn(input).ok, true);
  assert.equal(m.spawn({ ...input, task: "Look up the emails" }).ok, true);
  m.cancelAll();
  await m.waitForIdle(500);
  assert.deepEqual(m.status().map((helper) => helper.state), ["stopped", "stopped"]);
  assert.deepEqual(m.results().map((result) => result.outcome), ["aborted", "aborted"]);
});

test("finish waits at most the given time and then reports the helper honestly", async () => {
  const { manager: m } = manager(async () => new Promise(() => {}));
  const input = { task: "A slow lookup", tools: ["read_document"], parentStep: 1, limits: subagentLimits({ maxSteps: 60, maxTokens: 400_000, maxWallClockMs: 1_800_000 }), parentTools: ["read_document"], allowSpawn: true };
  assert.equal(m.spawn(input).ok, true);
  const started = Date.now();
  await m.waitForIdle(20);
  assert.ok(Date.now() - started < 500);
  assert.equal(m.status()[0].state, "running");
});
