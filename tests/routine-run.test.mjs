import assert from "node:assert/strict";
import test from "node:test";

const OWNER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const ROUTINE = "33333333-3333-4333-8333-333333333333";
const EXECUTION = "44444444-4444-8444-8444-444444444444";
const RUN = "55555555-5555-4555-8555-555555555555";

const routine = {
  id: ROUTINE, agentId: AGENT, sourceMessageId: "66666666-6666-4666-8666-666666666666", skillId: null,
  goal: "Prepare the brief.", steps: ["Open the dashboard", "Summarize changes"], schedule: "Every day at 09:00",
  scheduleSpec: { kind: "daily", cron: "0 9 * * *", display: "Every day at 09:00" }, timezone: "Asia/Kolkata",
  nextRunAt: "2026-11-05T03:30:00.000Z", tools: [], budgetCents: 300, catchUp: "run_once", active: true,
  mode: "cron", createdAt: "2026-11-01T00:00:00.000Z",
};
const job = { ownerId: OWNER, routineId: ROUTINE, agentId: AGENT, executionId: EXECUTION, trigger: "schedule", scheduledAt: "2026-11-04T03:30:00.000Z" };

function setup({ prepare, outcome = "finished" } = {}) {
  const seen = { options: null, deps: null, cards: [] };
  const sink = { runId: RUN, begin: async () => {}, step: async () => {}, seal: async () => {} };
  const start = {
    ok: true, persona: { id: AGENT, name: "Ada", role: "Researcher", soulMd: "Be careful.", actions: ["click"] },
    timezone: "Asia/Kolkata", provider: {}, model: "mock", hardModel: null, desktop: {}, receipts: () => sink,
  };
  const ports = {
    prepare: async (_owner, _agent, options) => {
      seen.options = options;
      return prepare ?? start;
    },
    postCard: async (_owner, _agent, card) => { seen.cards.push(card); },
    run: async (deps) => {
      seen.deps = deps;
      if (outcome === "throw") throw new Error("secret-token-123");
      return { outcome, cardPosted: outcome !== "busy" };
    },
  };
  return { ports, seen };
}

test("a routine run uses goal-before-steps text and records schedule metadata once the run starts", async () => {
  const { runRoutineExecution } = await import("../lib/routines/run.ts");
  const { ports, seen } = setup();
  const result = await runRoutineExecution({}, job, routine, 0, ports);
  assert.deepEqual(result, { outcome: "finished", runId: RUN, retry: false });
  assert.equal(seen.deps.task, "Prepare the brief.\n\nSteps:\n1. Open the dashboard\n2. Summarize changes");
  assert.deepEqual(seen.options.meta, {
    trigger: "schedule", routineId: ROUTINE, executionId: EXECUTION, label: "Prepare the brief.",
  });
  assert.equal(seen.deps.receipts.runId, RUN);
});

test("scheduled and Run Now executions forward security controls and attach the run ID to security stops", async () => {
  const { runRoutineExecution } = await import("../lib/routines/run.ts");
  for (const trigger of ["schedule", "run_now"]) {
    const { ports, seen } = setup();
    const originalPrepare = ports.prepare;
    const events = [];
    const controls = {
      canary: "test-canary", approvals: { request: async () => ({ decision: "deny" }) },
      allowedHosts: ["example.com"], onScopeBlocked: () => {},
      onSecurityStop: async (event) => { events.push(event); return "posted"; },
    };
    ports.prepare = async (...args) => ({ ...await originalPrepare(...args), ...controls });
    await runRoutineExecution({}, { ...job, trigger }, routine, 0, ports);
    for (const field of ["canary", "approvals", "allowedHosts", "onScopeBlocked"]) assert.equal(seen.deps[field], controls[field], field);
    assert.equal(await seen.deps.onSecurityStop({ step: 2, cause: "typed_text" }), "posted");
    assert.deepEqual(events, [{ step: 2, cause: "typed_text", runId: RUN }]);
  }
});

test("transient outcomes and thrown failures ask the queue to retry while owner stops complete", async () => {
  const { runRoutineExecution } = await import("../lib/routines/run.ts");
  for (const [outcome, retry] of [["provider_error", true], ["desktop_error", true], ["busy", true], ["throw", true], ["needs_owner", false], ["finished", false]]) {
    const { ports } = setup({ outcome });
    const result = await runRoutineExecution({}, job, routine, 0, ports);
    assert.equal(result.retry, retry, outcome);
    assert.ok(!JSON.stringify(result).includes("secret-token"), outcome);
  }
});

test("missing configuration posts one fixed card and is not retried; an unavailable desktop may retry", async () => {
  const { runRoutineExecution } = await import("../lib/routines/run.ts");
  const { CHAT_RUN_TEXT } = await import("../lib/agent/chat-run.ts");
  const noModel = setup({ prepare: { ok: false, reason: "no_model" } });
  let ran = false;
  noModel.ports.run = async () => { ran = true; return { outcome: "finished", cardPosted: true }; };
  assert.deepEqual(await runRoutineExecution({}, job, routine, 0, noModel.ports),
    { outcome: null, runId: null, retry: false, reason: "no_model" });
  assert.equal(ran, false);
  assert.deepEqual(noModel.seen.cards, [{ type: "message", text: CHAT_RUN_TEXT.no_model }]);

  const unavailable = setup({ prepare: { ok: false, reason: "unavailable" } });
  assert.deepEqual(await runRoutineExecution({}, job, routine, 0, unavailable.ports),
    { outcome: null, runId: null, retry: true, reason: "unavailable" });
  assert.deepEqual(unavailable.seen.cards, []);
});
