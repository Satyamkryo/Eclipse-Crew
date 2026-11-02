import assert from "node:assert/strict";
import test from "node:test";

const daily = { kind: "daily", cron: "0 9 * * *", display: "Every day at 09:00" };
const atNoon = new Date("2026-11-04T12:00:00.000Z");
const iso = (dates) => dates.map((date) => date.toISOString());

test("a scheduled execution id is stable, key-specific and a valid UUID", async () => {
  const { routineExecutionId } = await import("../lib/routines/execution-plan.ts");
  const routineId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const scheduledAt = new Date("2026-11-04T03:30:00.000Z");
  const first = routineExecutionId(routineId, scheduledAt);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(first, routineExecutionId(routineId, new Date(scheduledAt)));
  assert.notEqual(first, routineExecutionId(routineId, new Date("2026-11-05T03:30:00.000Z")));
  assert.notEqual(first, routineExecutionId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", scheduledAt));
});

test("catch-up drops missed occurrences, runs the latest, or returns the bounded backlog", async () => {
  const { selectRoutineOccurrences } = await import("../lib/routines/execution-plan.ts");
  const options = {
    spec: daily,
    timezone: "Asia/Kolkata",
    nextRunAt: new Date("2026-11-01T03:30:00.000Z"),
    now: atNoon,
  };
  const skipped = selectRoutineOccurrences({ ...options, catchUp: "skip" });
  assert.deepEqual(iso(skipped.scheduledAt), []);
  assert.equal(skipped.nextRunAt.toISOString(), "2026-11-05T03:30:00.000Z");
  assert.equal(skipped.active, true);
  assert.equal(skipped.more, false);

  const once = selectRoutineOccurrences({ ...options, catchUp: "run_once" });
  assert.deepEqual(iso(once.scheduledAt), ["2026-11-04T03:30:00.000Z"]);
  assert.equal(once.nextRunAt.toISOString(), "2026-11-05T03:30:00.000Z");

  const all = selectRoutineOccurrences({ ...options, catchUp: "run_all" });
  assert.deepEqual(iso(all.scheduledAt), [
    "2026-11-01T03:30:00.000Z",
    "2026-11-02T03:30:00.000Z",
    "2026-11-03T03:30:00.000Z",
    "2026-11-04T03:30:00.000Z",
  ]);
  assert.equal(all.nextRunAt.toISOString(), "2026-11-05T03:30:00.000Z");

  const bounded = selectRoutineOccurrences({ ...options, catchUp: "run_all", limit: 2 });
  assert.deepEqual(iso(bounded.scheduledAt), ["2026-11-01T03:30:00.000Z", "2026-11-02T03:30:00.000Z"]);
  assert.equal(bounded.nextRunAt.toISOString(), "2026-11-03T03:30:00.000Z");
  assert.equal(bounded.more, true);
});

test("an occurrence less than one minute old runs even when older runs are skipped", async () => {
  const { selectRoutineOccurrences } = await import("../lib/routines/execution-plan.ts");
  const result = selectRoutineOccurrences({
    spec: { kind: "cron", cron: "59 11 * * *", display: "11:59" },
    timezone: "UTC",
    nextRunAt: new Date("2026-11-03T11:59:00.000Z"),
    now: atNoon,
    catchUp: "skip",
  });
  assert.deepEqual(iso(result.scheduledAt), ["2026-11-04T11:59:00.000Z"]);
  assert.equal(result.nextRunAt.toISOString(), "2026-11-05T11:59:00.000Z");
});

test("a missed one-shot follows its policy once and never stays active", async () => {
  const { selectRoutineOccurrences } = await import("../lib/routines/execution-plan.ts");
  const options = {
    spec: { kind: "once", runAt: "2026-11-03T09:00:00.000Z", display: "Nov 3 at 09:00" },
    timezone: "UTC",
    nextRunAt: new Date("2026-11-03T09:00:00.000Z"),
    now: atNoon,
  };
  const skipped = selectRoutineOccurrences({ ...options, catchUp: "skip" });
  assert.deepEqual(iso(skipped.scheduledAt), []);
  assert.equal(skipped.active, false);

  const caughtUp = selectRoutineOccurrences({ ...options, catchUp: "run_once" });
  assert.deepEqual(iso(caughtUp.scheduledAt), ["2026-11-03T09:00:00.000Z"]);
  assert.equal(caughtUp.active, false);
  assert.equal(caughtUp.nextRunAt.toISOString(), "2026-11-03T09:00:00.000Z");
});

test("a future routine produces no job and routine task text keeps the goal before numbered steps", async () => {
  const { selectRoutineOccurrences, routineTaskText } = await import("../lib/routines/execution-plan.ts");
  const future = selectRoutineOccurrences({
    spec: daily, timezone: "Asia/Kolkata", nextRunAt: new Date("2026-11-05T03:30:00.000Z"),
    now: atNoon, catchUp: "run_all",
  });
  assert.deepEqual(iso(future.scheduledAt), []);
  assert.equal(future.nextRunAt.toISOString(), "2026-11-05T03:30:00.000Z");
  assert.match(routineTaskText("Prepare the brief.", ["Open the dashboard", "Summarize changes"]),
    /^Prepare the brief\.\n\nSteps:\n1\. Open the dashboard\n2\. Summarize changes$/);
  assert.match(routineTaskText("Use the skill.", []), /Use the approved skill/);
});

test("scheduled jobs carry one deterministic execution id and trigger per selected occurrence", async () => {
  const { scheduledRoutineJobs, routineExecutionId } = await import("../lib/routines/execution-plan.ts");
  const plan = scheduledRoutineJobs({
    ownerId: "11111111-1111-4111-8111-111111111111",
    routineId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    agentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    spec: daily,
    timezone: "Asia/Kolkata",
    nextRunAt: new Date("2026-11-04T03:30:00.000Z"),
    now: atNoon,
    catchUp: "run_once",
  });
  assert.equal(plan.jobs.length, 1);
  assert.deepEqual(plan.jobs[0], {
    ownerId: "11111111-1111-4111-8111-111111111111",
    routineId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    agentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    executionId: routineExecutionId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", new Date("2026-11-04T03:30:00.000Z")),
    trigger: "schedule",
    scheduledAt: "2026-11-04T03:30:00.000Z",
  });
  assert.equal(plan.nextRunAt.toISOString(), "2026-11-05T03:30:00.000Z");
  assert.equal(plan.active, true);
});

test("only transient run outcomes ask pg-boss to retry", async () => {
  const { routineOutcomeDisposition } = await import("../lib/routines/execution-plan.ts");
  for (const outcome of ["busy", "provider_error", "desktop_error", "time_limit", "receipt_error", "cost_error"]) {
    assert.equal(routineOutcomeDisposition(outcome), "retry", outcome);
  }
  for (const outcome of ["finished", "asked_owner", "needs_owner", "paused_by_owner", "budget_paused", "price_required", "aborted", "invalid_output", "step_limit", "token_limit", "repeat_limit"]) {
    assert.equal(routineOutcomeDisposition(outcome), "complete", outcome);
  }
});
