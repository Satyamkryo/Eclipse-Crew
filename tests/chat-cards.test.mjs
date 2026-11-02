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
    resolvedNextRunAt: "2026-11-02T03:30:00.000Z",
  });
  assert.match(routine, /Every weekday at 09:00/);
  assert.match(routine, /Prepare the daily brief\./);
  assert.match(routine, /Asia\/Kolkata/);
  assert.match(routine, /\$3\.00/);
  assert.match(routine, /Next run/);
  assert.doesNotMatch(routine, />Confirm routine</, "no confirmation without an agent and CSRF token");

  const confirmable = renderToStaticMarkup(React.createElement(ChatCard, {
    message: message({
      type: "routine",
      goal: "Prepare the daily brief.",
      steps: ["Open the dashboard"],
      schedule: "Every weekday at 09:00",
      timezone: "Asia/Kolkata",
      tools: [],
      budgetCents: 300,
      catchUp: "run_all",
    }),
    agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    csrfToken: "token",
  }));
  assert.match(confirmable, />Confirm routine</);
  assert.match(confirmable, /Run all missed/);

  const warning = render({ type: "budget_warning", period: "daily", spentMicroUsd: 800_000, limitCents: 100 });
  assert.match(warning, /Budget warning/);
  assert.match(warning, /80%/);
  assert.match(warning, /\$0\.80 of \$1\.00/);
  const paused = render({ type: "budget_paused", period: "monthly", spentMicroUsd: 1_250_000, limitCents: 100 });
  assert.match(paused, /Budget paused/);
  assert.match(paused, /monthly/i);
  assert.match(paused, /paused/i);
  assert.doesNotMatch(paused, /<button|<a /);
});

test("file cards show the safe name, direction, kind and size, and never render markup from a name", async () => {
  const { ChatCard } = unwrap(await import("../components/chat/chat-card.tsx"));
  const render = (card, sourceTag = "user") => renderToStaticMarkup(React.createElement(ChatCard, {
    message: { id: MESSAGE, role: sourceTag === "user" ? "user" : "agent", card, sourceTag, runId: null, createdAt: "2026-11-01T00:00:00.000Z" },
  }));
  const inbox = render({ type: "file", direction: "inbox", name: "<img src=x onerror=alert(1)>.png", size: 12 * 1024 * 1024, kind: "image", sha256: "a".repeat(64) });
  assert.match(inbox, /data-card-type="file"/);
  assert.match(inbox, /aria-label="Your file"/);
  assert.match(inbox, /&lt;img src=x onerror=alert\(1\)&gt;\.png/);
  assert.doesNotMatch(inbox, /<img/);
  assert.match(inbox, /inbox/);
  assert.match(inbox, /Image/);
  assert.match(inbox, /12 MB/);
  assert.doesNotMatch(inbox, /<button|<a /, "download and open actions arrive with the outbox task");
  const outbox = render({ type: "file", direction: "outbox", name: "summary.pdf", size: 2048, kind: "pdf", sha256: "b".repeat(64) }, "agent");
  assert.match(outbox, /aria-label="Agent file"/);
  assert.match(outbox, /outbox/);
  assert.match(outbox, /PDF/);
  assert.match(outbox, /2 KB/);
});

test("outbox file cards offer Download and, only for safe kinds, Open on the desktop; inbox cards offer neither", async () => {
  const { ChatCard } = unwrap(await import("../components/chat/chat-card.tsx"));
  const render = (card, props = { agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", csrfToken: "token" }) => renderToStaticMarkup(React.createElement(ChatCard, {
    message: { id: MESSAGE, role: "agent", card, sourceTag: "tool", runId: null, createdAt: "2026-11-01T00:00:00.000Z" }, ...props,
  }));
  const file = (name, kind, direction = "outbox") => ({ type: "file", direction, name, size: 2048, kind, sha256: "c".repeat(64) });
  const pdf = render(file("summary.pdf", "pdf"));
  assert.match(pdf, /href="\/api\/agents\/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\/files\/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"/);
  assert.match(pdf, /download/); assert.match(pdf, /aria-label="Download summary\.pdf"/); assert.match(pdf, /Open on desktop/);
  const archive = render(file("bundle.zip", "archive"));
  assert.match(archive, /Download/); assert.doesNotMatch(archive, /Open on desktop/, "archives are download-only");
  assert.doesNotMatch(render(file("page.html", "text")), /Open on desktop/, "HTML never opens in the agent's browser");
  const inbox = render(file("mine.pdf", "pdf", "inbox"));
  assert.doesNotMatch(inbox, /Download|Open on desktop|<button|<a /);
  assert.doesNotMatch(render(file("summary.pdf", "pdf"), {}), /<button|<a /, "no actions without an agent and a CSRF token");
  assert.doesNotMatch(render(file("<script>alert(1)</script>.txt", "text")), /<script>/);
});

test("a skill update card names the failed step and version, and asks for review instead of acting", async () => {
  const { ChatCard } = unwrap(await import("../components/chat/chat-card.tsx"));
  const html = renderToStaticMarkup(React.createElement(ChatCard, {
    message: {
      id: MESSAGE, role: "agent", sourceTag: "agent", runId: null, createdAt: "2026-11-01T00:00:00.000Z",
      card: {
        type: "skill_update", proposalId: MESSAGE, scriptName: "Download invoice", fromVersion: 1, toVersion: 2,
        failedStep: 2, changedSteps: 2, failureCode: "target_missing",
      },
    },
  }));
  assert.match(html, /data-card-type="skill_update"/);
  assert.match(html, /Skill update proposed/);
  assert.match(html, /step 2/);
  assert.match(html, /v1/);
  assert.match(html, /border-corona/);
  assert.match(html, /Open the saved replay in History to review this update\./);
  assert.doesNotMatch(html, /<button/);
});
