import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const OWNER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const ROUTINE = "33333333-3333-4333-8333-333333333333";
const EXECUTION = "44444444-4444-8444-8444-444444444444";

test("routine jobs are strict, owner-scoped and limited to scheduled or manual triggers", async () => {
  const { routineJobSchema, ROUTINE_QUEUE, ROUTINE_RETRY } = await import("../lib/routines/queue.ts");
  assert.equal(ROUTINE_QUEUE, "routine.run");
  assert.deepEqual(ROUTINE_RETRY, { retryLimit: 2, retryDelay: 30, retryBackoff: true, retryDelayMax: 300, expireInSeconds: 1200 });
  const base = { ownerId: OWNER, routineId: ROUTINE, agentId: AGENT, executionId: EXECUTION };
  assert.deepEqual(routineJobSchema.parse({ ...base, trigger: "schedule", scheduledAt: "2026-11-04T03:30:00.000Z" }).trigger, "schedule");
  assert.deepEqual(routineJobSchema.parse({ ...base, trigger: "run_now" }).trigger, "run_now");
  assert.equal(routineJobSchema.safeParse({ ...base, trigger: "schedule", scheduledAt: "not-a-date" }).success, false);
  assert.equal(routineJobSchema.safeParse({ ...base, trigger: "run_now", apiKey: "secret" }).success, false);
  assert.equal(routineJobSchema.safeParse({ ...base, trigger: "chat" }).success, false);
});

test("the pinned queue dependency, execution metadata and least-privilege migration are present", async () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(pkg.dependencies["pg-boss"], "12.38.0");
  const migration = readFileSync("drizzle/0019_mute_thunderbird.sql", "utf8");
  assert.match(migration, /ADD COLUMN "execution_id" uuid/);
  assert.match(migration, /CREATE SCHEMA IF NOT EXISTS pgboss/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO eclipse_app/);
  assert.doesNotMatch(migration, /GRANT ALL|OWNER TO eclipse_app/);
  const schema = readFileSync("db/schema.ts", "utf8");
  assert.match(schema, /executionId: uuid\("execution_id"\)/);
});

test("manual executions are unique UUIDs and jobs are grouped by agent with the execution as singleton key", async () => {
  const { manualRoutineExecutionId, routineGroup, routineSingletonKey } = await import("../lib/routines/queue.ts");
  const first = manualRoutineExecutionId();
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first, manualRoutineExecutionId());
  assert.deepEqual(routineGroup(AGENT), { id: AGENT });
  assert.equal(routineSingletonKey(EXECUTION), EXECUTION);
});
