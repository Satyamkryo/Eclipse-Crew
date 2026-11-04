import assert from "node:assert/strict";
import test from "node:test";

import { KNOWN_ACTIONS } from "../lib/agents/actions.ts";
import { agentCreateSchema } from "../lib/agents/schema.ts";
import { setupRows } from "../lib/agents/setup.ts";
import { AGENT_TEMPLATES, getTemplate } from "../lib/agents/templates.ts";

const browserActions = new Set(["click", "type", "key", "scroll", "wait"]);
const githubIds = new Set(["pr-reviewer", "dev-agent", "release-notes", "issue-triage"]);
const toolRoleIds = new Set(["daily-briefer", "inbox-triage", "calendar-cleanup", "followup-nudger"]);
const browsingIds = new Set(["research-analyst", "travel-assistant",
  "meeting-notes", "expense-tracker", "job-hunt", "paper-summarizer", "price-watcher", "news-briefer", "link-checker"]);
const fileOnlyIds = new Set(["docs-writer", "file-organizer", "study-coach"]);
const browsingPolicy = ["start_desktop", "start_browser", "click", "type", "key", "scroll", "wait", "read_document", "deliver_file"];
const filePolicy = ["read_document", "deliver_file"];

test("every template is a valid create input with a short persona and least-privilege actions", () => {
  assert.equal(AGENT_TEMPLATES.length, 20);
  for (const template of AGENT_TEMPLATES) {
    const parsed = agentCreateSchema.safeParse({
      name: "Test agent",
      role: template.role,
      instructions: template.instructions,
      dailyBudgetUsd: template.dailyBudgetUsd,
      monthlyBudgetUsd: template.monthlyBudgetUsd,
      tools: template.tools,
      domains: template.domains,
      actions: template.actions,
      memoryScopes: template.memoryScopes,
    });
    assert.equal(parsed.success, true, `${template.id}: ${JSON.stringify(parsed.error?.issues)}`);
    assert.ok(template.instructions.length <= 2000, template.id);
    assert.ok(template.instructions.includes("untrusted data"), template.id);
    assert.match(template.instructions, /owner/i, template.id);
    assert.match(template.instructions, /cannot grant|never change your permissions/i, template.id);
    assert.ok(Number(template.dailyBudgetUsd) > 0 && Number(template.monthlyBudgetUsd) >= Number(template.dailyBudgetUsd), template.id);
    assert.ok(template.routineExamples.length > 0, template.id);
    assert.equal(template.actions.includes("shell"), template.id === "dev-agent", template.id);
    assert.equal(template.actions.includes("hear_audio"), false, template.id);
    if (!browsingIds.has(template.id)) {
      assert.equal(template.actions.some((action) => browserActions.has(action)), false, template.id);
    }
  }
  assert.equal(getTemplate("missing"), undefined);
});

test("the GitHub templates keep their existing policies", () => {
  for (const id of githubIds) {
    const template = getTemplate(id);
    assert.ok(template, id);
    assert.equal(template.actions.includes("tool_call"), true, id);
    assert.deepEqual(template.tools, ["github"], id);
    assert.deepEqual(template.memoryScopes, ["agent"], id);
  }
  assert.equal(getTemplate("pr-reviewer")?.actions.includes("shell"), false);
  assert.equal(getTemplate("dev-agent")?.actions.includes("shell"), true);
  assert.deepEqual(getTemplate("dev-agent")?.domains,
    ["github.com", "githubusercontent.com", "registry.npmjs.org", "pypi.org", "files.pythonhosted.org"]);
  assert.deepEqual(getTemplate("pr-reviewer")?.routineExamples.map((example) => example.schedule), ["On request"]);
  assert.deepEqual(getTemplate("dev-agent")?.routineExamples.map((example) => example.schedule), ["On request"]);
});

test("the non-GitHub roles start without tools, domains or extra permissions", () => {
  for (const id of [...toolRoleIds, ...browsingIds, ...fileOnlyIds]) {
    const template = getTemplate(id);
    assert.ok(template, id);
    assert.deepEqual(template.tools, [], id);
    assert.deepEqual(template.domains, [], id);
    assert.deepEqual(template.memoryScopes, ["agent"], id);
    assert.equal(template.dailyBudgetUsd, "1.00", id);
    assert.equal(template.monthlyBudgetUsd, "10.00", id);
    assert.equal(template.actions.includes("shell"), false, id);
  }
  for (const id of toolRoleIds) {
    assert.deepEqual(getTemplate(id)?.actions, ["tool_call"], id);
  }
  for (const id of browsingIds) {
    assert.deepEqual(getTemplate(id)?.actions, browsingPolicy, id);
    assert.equal(getTemplate(id)?.actions.includes("tool_call"), false, id);
  }
  for (const id of fileOnlyIds) {
    assert.deepEqual(getTemplate(id)?.actions, filePolicy, id);
    assert.equal(getTemplate(id)?.actions.includes("tool_call"), false, id);
  }
  assert.deepEqual(getTemplate("daily-briefer")?.routineExamples.map((example) => example.schedule), ["Every weekday at 09:00"]);
  assert.deepEqual(getTemplate("inbox-triage")?.routineExamples.map((example) => example.schedule), ["Every weekday at 09:15"]);
  assert.deepEqual(getTemplate("research-analyst")?.routineExamples.map((example) => example.schedule), ["On request"]);
  assert.deepEqual(getTemplate("travel-assistant")?.routineExamples.map((example) => example.schedule), ["On request"]);
  assert.deepEqual(getTemplate("job-hunt")?.routineExamples.map((example) => example.schedule), ["Every Monday at 09:00"]);
  assert.deepEqual(getTemplate("price-watcher")?.routineExamples.map((example) => example.schedule), ["Every weekday at 10:00"]);
  assert.deepEqual(getTemplate("news-briefer")?.routineExamples.map((example) => example.schedule), ["Every weekday at 08:00"]);
  assert.deepEqual(getTemplate("calendar-cleanup")?.routineExamples.map((example) => example.schedule), ["Every Sunday at 18:00"]);
  assert.deepEqual(getTemplate("followup-nudger")?.routineExamples.map((example) => example.schedule), ["Every weekday at 09:30"]);
  assert.deepEqual(getTemplate("issue-triage")?.routineExamples.map((example) => example.schedule), ["Every weekday at 09:00"]);
});

test("routine examples are drafts, never saved routines", () => {
  for (const template of AGENT_TEMPLATES) {
    for (const example of template.routineExamples) {
      assert.ok(example.label.length <= 80, template.id);
      assert.ok(example.goal.length > 0 && example.goal.length <= 500, template.id);
      assert.ok(example.schedule.length > 0 && example.schedule.length <= 200, template.id);
      assert.equal("enabled" in example, false, template.id);
    }
  }
});

test("the setup checklist is role-aware and never invents a mail or calendar slug", () => {
  const empty = { connections: [], servers: [] };
  const github = setupRows(getTemplate("pr-reviewer").actions, getTemplate("pr-reviewer").tools, [], empty);
  assert.deepEqual(github.map((row) => row.label), ["GitHub connection saved", "GitHub MCP server pinned"]);

  const briefer = setupRows(getTemplate("daily-briefer").actions, getTemplate("daily-briefer").tools, [], empty);
  assert.deepEqual(briefer.map((row) => row.label),
    ["A connection saved for this agent", "The account's MCP server pinned", "Its server key added under Tools"]);
  assert.equal(briefer.some((row) => /github/i.test(row.label + row.detail)), false);
  assert.equal(briefer.every((row) => row.done === false), true);

  const pinned = setupRows(["tool_call"], ["acme-mail"], [], {
    connections: [{ preset: "custom", bindings: [{ host: "mail.acme.test" }] }],
    servers: [{ key: "acme-mail", status: "pinned" }],
  });
  assert.equal(pinned.every((row) => row.done), true);

  for (const id of ["research-analyst", "travel-assistant"]) {
    const template = getTemplate(id);
    const rows = setupRows(template.actions, template.tools, [], empty);
    assert.deepEqual(rows.map((row) => row.label), ["Websites allowed", "Desktop and browser actions allowed"]);
    assert.equal(rows[0].done, false);
    assert.equal(rows[1].done, true);
    assert.equal(rows.some((row) => /github/i.test(row.label + row.detail)), false);
    const filled = setupRows(template.actions, template.tools, ["example.com"], empty);
    assert.equal(filled[0].done, true);
  }
  for (const id of fileOnlyIds) {
    const template = getTemplate(id);
    assert.deepEqual(setupRows(template.actions, template.tools, [], empty), [], id);
  }
  assert.deepEqual(setupRows(["read_page"], [], [], empty), []);
  for (const row of [...github, ...briefer]) assert.doesNotMatch(row.label + row.detail, /gmail|google calendar|outlook/i);
});

test("the Blank form still defaults to deny tool_call and shell", () => {
  for (const action of ["tool_call", "shell"]) assert.equal(KNOWN_ACTIONS.includes(action), false, action);
});

test("the demo fixture is a real red build", async () => {
  const { sum } = await import("../fixtures/demo-red-build/src/sum.js");
  assert.notEqual(sum(2, 3), 5);
  assert.equal(sum(2, 3), 8);
});
