import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const unwrap = (module) => module.default ?? module;
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("routine routes expose owner-only read and confirmation without other methods", async () => {
  const route = unwrap(await import("../app/api/agents/[agentId]/routines/[messageId]/route.ts"));
  assert.equal(typeof route.GET, "function");
  assert.equal(typeof route.POST, "function");
  for (const method of ["PUT", "PATCH", "DELETE"]) assert.equal(route[method], undefined, method);
  assert.equal(route.runtime, "nodejs");
  assert.equal(route.dynamic, "force-dynamic");

  const messageId = randomUUID();
  const params = { params: Promise.resolve({ agentId: AGENT, messageId }) };
  const read = await route.GET(new Request(`http://127.0.0.1:3000/api/agents/${AGENT}/routines/${messageId}`), params);
  assert.equal(read.status, 401);
  assert.equal(read.headers.get("cache-control"), "no-store");
  const confirm = await route.POST(new Request(`http://127.0.0.1:3000/api/agents/${AGENT}/routines/${messageId}`, { method: "POST" }), params);
  assert.equal(confirm.status, 401);

  const invalid = await route.GET(new Request("http://127.0.0.1:3000/api/agents/not-a-uuid/routines/not-a-uuid"),
    { params: Promise.resolve({ agentId: "not-a-uuid", messageId: "not-a-uuid" }) });
  assert.equal(invalid.status, 401, "authentication is checked before route input");
});

test("routine cards accept run-all catch-up and an optional approved skill but no secret fields", async () => {
  const schema = unwrap(await import("../lib/chat/schema.ts"));
  const base = {
    type: "routine",
    goal: "Prepare the brief.",
    steps: [],
    schedule: "Every weekday at 09:00",
    timezone: "Asia/Kolkata",
    tools: [],
    budgetCents: 300,
    catchUp: "run_all",
    skillId: randomUUID(),
  };
  assert.equal(schema.chatCardSchema.safeParse(base).success, true);
  assert.equal(schema.chatCardSchema.safeParse({ ...base, steps: [], skillId: undefined }).success, false);
  assert.equal(schema.chatCardSchema.safeParse({ ...base, apiKey: "secret" }).success, false);
});
