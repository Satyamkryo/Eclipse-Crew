import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { getTableName } from "drizzle-orm";

const unwrap = (module) => module.default ?? module;
const OWNER = "11111111-1111-4111-8111-111111111111";
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MESSAGE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("chat cards normalize valid message, clarification, tool connection and routine payloads", async () => {
  const schema = unwrap(await import("../lib/chat/schema.ts"));
  assert.deepEqual(schema.chatCardSchema.parse({
    type: "message",
    text: "  The report is ready.\n",
  }), {
    type: "message",
    text: "The report is ready.",
  });
  assert.deepEqual(schema.chatCardSchema.parse({
    type: "clarification",
    question: "Which account should I use?",
    missingParameters: [" account ", "account", "site"],
  }), {
    type: "clarification",
    question: "Which account should I use?",
    missingParameters: ["account", "site"],
  });
  assert.deepEqual(schema.chatCardSchema.parse({
    type: "tool_connection",
    tool: "GitHub",
    name: " GitHub ",
    description: "Connect GitHub to read pull requests.",
  }), {
    type: "tool_connection",
    tool: "github",
    name: "GitHub",
    description: "Connect GitHub to read pull requests.",
  });
  assert.deepEqual(schema.chatCardSchema.parse({
    type: "routine",
    goal: "  Prepare the daily brief. ",
    steps: [" Open the dashboard ", "Summarize changes"],
    schedule: "Every weekday at 09:00",
    timezone: "Asia/Kolkata",
    tools: [" WEB.fetch ", "web.fetch"],
    budgetCents: 300,
    catchUp: "run_once",
  }), {
    type: "routine",
    goal: "Prepare the daily brief.",
    steps: ["Open the dashboard", "Summarize changes"],
    schedule: "Every weekday at 09:00",
    timezone: "Asia/Kolkata",
    tools: ["web.fetch"],
    budgetCents: 300,
    catchUp: "run_once",
  });
});

test("chat cards reject unknown, unsafe, malformed and unbounded fields", async () => {
  const schema = unwrap(await import("../lib/chat/schema.ts"));
  const message = { type: "message", text: "Ready." };
  const routine = {
    type: "routine",
    goal: "Prepare the brief.",
    steps: ["Open the dashboard"],
    schedule: "Every weekday at 09:00",
    timezone: "Asia/Kolkata",
    tools: ["web.fetch"],
    budgetCents: 300,
    catchUp: "run_once",
  };
  for (const invalid of [
    { ...message, role: "agent" },
    { ...message, text: "" },
    { ...message, text: "bad\u0000text" },
    { ...message, text: "x".repeat(20_001) },
    { type: "unknown", text: "Ready." },
    { type: "clarification", question: "Which?", missingParameters: [] },
    { type: "clarification", question: "Which?", missingParameters: ["Account", "account"] },
    { type: "tool_connection", tool: "web fetch", name: "Web", description: "Read pages." },
    { ...routine, timezone: "Mars/Olympus" },
    { ...routine, budgetCents: 0 },
    { ...routine, steps: [] },
    { ...routine, catchUp: "retry_forever" },
    { ...routine, steps: Array.from({ length: 33 }, (_, index) => `Step ${index}`) },
  ]) assert.equal(schema.chatCardSchema.safeParse(invalid).success, false, JSON.stringify(invalid));
});

test("user message input accepts only bounded text and history queries reject ambiguous cursors", async () => {
  const schema = unwrap(await import("../lib/chat/schema.ts"));
  assert.deepEqual(schema.userMessageInputSchema.parse({ text: "  Prepare the brief.  " }), { text: "Prepare the brief." });
  for (const invalid of [
    { text: "Ready.", role: "agent" },
    { text: "Ready.", runId: MESSAGE },
    { text: "" },
    { text: "x".repeat(20_001) },
  ]) assert.equal(schema.userMessageInputSchema.safeParse(invalid).success, false);
  assert.deepEqual(schema.chatHistoryQuerySchema.parse({}), {});
  assert.deepEqual(schema.chatHistoryQuerySchema.parse({ before: MESSAGE }), { before: MESSAGE });
  assert.deepEqual(schema.chatHistoryQuerySchema.parse({ after: MESSAGE }), { after: MESSAGE });
  for (const invalid of [
    { before: MESSAGE, after: MESSAGE },
    { before: "not-a-uuid" },
    { limit: "100" },
  ]) assert.equal(schema.chatHistoryQuerySchema.safeParse(invalid).success, false);
});

test("chat persistence tables expose only owner-scoped, source-tagged cards", async () => {
  const schema = unwrap(await import("../db/schema.ts"));
  assert.equal(getTableName(schema.chatSessions), "chat_sessions");
  assert.equal(getTableName(schema.messages), "messages");
  assert.equal(schema.chatSessions.ownerId.name, "owner_id");
  assert.equal(schema.chatSessions.agentId.name, "agent_id");
  assert.equal(schema.messages.ownerId.name, "owner_id");
  assert.equal(schema.messages.sessionId.name, "session_id");
  assert.deepEqual(
    ["role", "cardType", "content", "sourceTag", "runId", "createdAt"].map((field) => schema.messages[field].name),
    ["role", "card_type", "content", "source_tag", "run_id", "created_at"],
  );
});

test("chat migration and runtime grants are explicitly allowlisted", () => {
  const provision = readFileSync("db/provision.sql", "utf8");
  const migrate = readFileSync("scripts/db-migrate.mjs", "utf8");
  for (const table of ["chat_sessions", "messages"]) {
    assert.match(provision, new RegExp(`'${table}'`), `${table} is an allowed provision object`);
    assert.match(migrate, new RegExp(`public\\.${table}`), `${table} receives an explicit runtime grant`);
    assert.match(provision, new RegExp(`GRANT SELECT, INSERT ON public\\.${table}`),
      `${table} is append-only for the runtime`);
  }
  assert.match(provision, /migration_count >= 5/);
});

test("chat routes expose authenticated history and user-only mutations", async () => {
  const route = unwrap(await import("../app/api/agents/[agentId]/messages/route.ts"));
  assert.equal(typeof route.GET, "function");
  assert.equal(typeof route.POST, "function");
  assert.equal(route.PATCH, undefined);
  assert.equal(route.DELETE, undefined);
  assert.equal(route.runtime, "nodejs");
  assert.equal(route.dynamic, "force-dynamic");
});

test("agent card writes validate and bound source before touching storage", async () => {
  const data = unwrap(await import("../lib/chat/data.ts"));
  for (const invalid of [
    { card: { type: "message", text: "" }, sourceTag: "agent" },
    { card: { type: "message", text: "Ready." }, sourceTag: "user" },
    { card: { type: "tool_connection", tool: "github", name: "GitHub", description: "Connect.", role: "agent" }, sourceTag: "agent" },
    { card: { type: "message", text: "Ready." }, sourceTag: "agent", runId: "not-a-uuid" },
    { card: { type: "message", text: "Ready." }, sourceTag: "agent", ownerId: OWNER },
  ]) {
    await assert.rejects(data.appendAgentCard(null, OWNER, AGENT, invalid), (error) => error.code === "invalid_card");
  }
});
