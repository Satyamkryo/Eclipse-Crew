import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const unwrap = (module) => module.default ?? module;
const MESSAGE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("chat cards render safe text, all four types and no premature actions", async () => {
  const { ChatCard } = unwrap(await import("../components/chat/chat-card.tsx"));
  const message = (card) => ({
    id: MESSAGE,
    role: "agent",
    card,
    sourceTag: "agent",
    runId: null,
    createdAt: "2026-11-01T00:00:00.000Z",
  });
  const render = (card) => renderToStaticMarkup(React.createElement(ChatCard, { message: message(card) }));

  const plain = render({ type: "message", text: "<script>alert(1)</script>\nReady." });
  assert.match(plain, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(plain, /<script>/);
  assert.match(plain, /data-card-type="message"/);

  const clarification = render({
    type: "clarification",
    question: "Which account should I use?",
    missingParameters: ["Account", "Site"],
  });
  assert.match(clarification, /More information needed/);
  assert.match(clarification, /Account/);
  assert.match(clarification, /Site/);

  const tool = render({
    type: "tool_connection",
    tool: "github",
    name: "GitHub",
    description: "Connect GitHub to read pull requests.",
  });
  assert.match(tool, /Connect GitHub/);
  assert.match(tool, /Connection required/);
  assert.doesNotMatch(tool, />Connect<|>Confirm</);

  const routine = render({
    type: "routine",
    goal: "Prepare the daily brief.",
    steps: ["Open the dashboard", "Summarize changes"],
    schedule: "Every weekday at 09:00",
    timezone: "Asia/Kolkata",
    tools: ["web.fetch"],
    budgetCents: 300,
    catchUp: "run_once",
  });
  assert.match(routine, /Every weekday at 09:00/);
  assert.match(routine, /Prepare the daily brief\./);
  assert.match(routine, /Asia\/Kolkata/);
  assert.match(routine, /\$3\.00/);
  assert.doesNotMatch(routine, />Confirm routine</);
});
