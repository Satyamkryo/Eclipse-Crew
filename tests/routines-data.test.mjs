import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getTableName } from "drizzle-orm";

const unwrap = (module) => module.default ?? module;
const NOW = new Date("2026-11-01T12:00:00Z");

test("routine records and confirmation responses accept skill-only routines and enforce step limits", async () => {
  const { routineRecordSchema, routineConfirmResponseSchema } = await import("../lib/routines/schema.ts");
  const record = {
    id: "11111111-1111-4111-8111-111111111111", agentId: "22222222-2222-4222-8222-222222222222",
    sourceMessageId: "33333333-3333-4333-8333-333333333333", skillId: "44444444-4444-4444-8444-444444444444",
    goal: "Prepare the brief", steps: [], schedule: "Every day at 09:00",
    scheduleSpec: { kind: "daily", cron: "0 9 * * *", display: "Every day at 09:00" },
    timezone: "UTC", nextRunAt: "2026-11-05T09:00:00.000Z", tools: [], budgetCents: 300,
    catchUp: "run_once", active: true, mode: "cron", createdAt: "2026-11-01T00:00:00.000Z",
  };
  for (const schema of [routineRecordSchema, routineConfirmResponseSchema]) {
    const wrap = (value) => schema === routineRecordSchema ? value : { routine: value };
    assert.equal(schema.safeParse(wrap(record)).success, true);
    assert.equal(schema.safeParse(wrap({ ...record, skillId: null })).success, false);
    assert.equal(schema.safeParse(wrap({ ...record, skillId: null, steps: ["Open dashboard"] })).success, true);
    assert.equal(schema.safeParse(wrap({ ...record, steps: [""] })).success, false);
    assert.equal(schema.safeParse(wrap({ ...record, steps: ["x".repeat(2001)] })).success, false);
    assert.equal(schema.safeParse(wrap({ ...record, steps: Array(32).fill("step") })).success, true);
    assert.equal(schema.safeParse(wrap({ ...record, steps: Array(33).fill("step") })).success, false);
  }
});

test("routine cards resolve relative dates in code and reject model-supplied resolution fields", async () => {
  const { prepareRoutineCard } = await import("../lib/routines/data.ts");
  const card = {
    type: "routine",
    goal: "Prepare the daily brief.",
    steps: ["Open the dashboard", "Summarize changes"],
    schedule: "Next Friday 9am",
    timezone: "Asia/Kolkata",
    tools: ["web.fetch"],
    budgetCents: 300,
    catchUp: "run_once",
    resolvedNextRunAt: "2099-01-01T00:00:00.000Z",
    scheduleSpec: { kind: "once", runAt: "2099-01-01T00:00:00.000Z", display: "forged" },
  };
  assert.deepEqual(prepareRoutineCard(card, { now: NOW }), {
    type: "routine",
    goal: "Prepare the daily brief.",
    steps: ["Open the dashboard", "Summarize changes"],
    schedule: "Next Friday 9am",
    timezone: "Asia/Kolkata",
    tools: ["web.fetch"],
    budgetCents: 300,
    catchUp: "run_once",
    scheduleSpec: { kind: "once", runAt: "2026-11-06T03:30:00.000Z", display: "Next Friday 9am" },
    resolvedNextRunAt: "2026-11-06T03:30:00.000Z",
  });
  assert.equal(prepareRoutineCard({ ...card, schedule: "tomorrow at 09:00" }, { now: NOW }).resolvedNextRunAt, "2026-11-02T03:30:00.000Z");
  assert.throws(() => prepareRoutineCard({ ...card, schedule: "sometime soon" }, { now: NOW }));
});

test("the routines table stores a normalized schedule with owner, agent, source message and optional skill", async () => {
  const schema = unwrap(await import("../db/schema.ts"));
  assert.equal(getTableName(schema.routines), "routines");
  assert.deepEqual(
    ["id", "ownerId", "agentId", "sourceMessageId", "skillId", "goal", "steps", "schedule", "scheduleSpec", "timezone", "nextRunAt", "tools", "budgetCents", "catchUp", "active", "mode", "createdAt", "updatedAt"]
      .map((field) => schema.routines[field].name),
    ["id", "owner_id", "agent_id", "source_message_id", "skill_id", "goal", "steps", "schedule", "schedule_spec", "timezone", "next_run_at", "tools", "budget_cents", "catch_up", "active", "mode", "created_at", "updated_at"],
  );
  assert.equal(schema.routines.sourceMessageId.isUnique, true);
});

test("routine migration and runtime grants are explicit and mutable only through owner confirmation", () => {
  const provision = readFileSync("db/provision.sql", "utf8");
  const migrate = readFileSync("scripts/db-migrate.mjs", "utf8");
  assert.match(provision, /'routines'/);
  assert.match(provision, /GRANT SELECT, INSERT, UPDATE ON public\.routines TO eclipse_app/);
  assert.match(migrate, /GRANT SELECT, INSERT, UPDATE ON public\.routines TO eclipse_app/);
});
