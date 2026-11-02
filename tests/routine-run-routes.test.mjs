import assert from "node:assert/strict";
import test from "node:test";

const ROUTINE = "33333333-3333-4333-8333-333333333333";
const EXECUTION = "44444444-4444-8444-8444-444444444444";

test("Run Now and execution status routes expose only owner-authenticated GET and POST surfaces", async () => {
  const run = await import("../app/api/routines/[routineId]/run/route.ts");
  assert.equal(run.runtime, "nodejs");
  assert.equal(run.dynamic, "force-dynamic");
  assert.equal(typeof run.POST, "function");
  assert.equal(run.GET, undefined);
  const start = await run.POST(new Request(`http://127.0.0.1:3000/api/routines/${ROUTINE}/run`, { method: "POST" }),
    { params: Promise.resolve({ routineId: ROUTINE }) });
  assert.equal(start.status, 401);
  assert.equal(start.headers.get("cache-control"), "no-store");

  const status = await import("../app/api/routines/[routineId]/executions/[executionId]/route.ts");
  assert.equal(typeof status.GET, "function");
  assert.equal(status.POST, undefined);
  const read = await status.GET(new Request(`http://127.0.0.1:3000/api/routines/${ROUTINE}/executions/${EXECUTION}`),
    { params: Promise.resolve({ routineId: ROUTINE, executionId: EXECUTION }) });
  assert.equal(read.status, 401);
  assert.equal(read.headers.get("cache-control"), "no-store");
});

test("Run Now is rate limited to five starts per minute without exposing caller identity", async () => {
  const { checkRoutineRunRateLimit, resetRoutineRunRateLimit } = await import("../lib/routines/rate-limit.ts");
  resetRoutineRunRateLimit();
  const now = Date.parse("2026-11-04T12:00:00.000Z");
  for (let index = 0; index < 5; index++) assert.equal(checkRoutineRunRateLimit(now).allowed, true);
  const denied = checkRoutineRunRateLimit(now);
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfter >= 1 && denied.retryAfter <= 60);
  assert.equal(checkRoutineRunRateLimit(now + 61_000).allowed, true);
  resetRoutineRunRateLimit();
});

test("manual execution ids are UUIDv4", async () => {
  const { manualRoutineExecutionId } = await import("../lib/routines/queue.ts");
  assert.match(manualRoutineExecutionId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
