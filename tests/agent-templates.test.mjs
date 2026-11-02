import assert from "node:assert/strict";
import test from "node:test";

import { KNOWN_ACTIONS } from "../lib/agents/actions.ts";
import { agentCreateSchema } from "../lib/agents/schema.ts";
import { AGENT_TEMPLATES, getTemplate } from "../lib/agents/templates.ts";

const browserActions = new Set(["click", "type", "key", "scroll", "wait"]);

test("every template is a valid create input with a short persona and least-privilege actions", () => {
  assert.equal(AGENT_TEMPLATES.length, 2);
  for (const template of AGENT_TEMPLATES) {
    const parsed = agentCreateSchema.safeParse({
      name: "Test agent",
      role: template.role,
      soulMd: template.soulMd,
      dailyBudgetUsd: template.dailyBudgetUsd,
      monthlyBudgetUsd: template.monthlyBudgetUsd,
      tools: template.tools,
      domains: template.domains,
      actions: template.actions,
      memoryScopes: template.memoryScopes,
    });
    assert.equal(parsed.success, true, `${template.id}: ${JSON.stringify(parsed.error?.issues)}`);
    assert.ok(template.soulMd.length <= 2000, template.id);
    assert.equal(template.actions.some((action) => browserActions.has(action)), false, template.id);
    assert.equal(template.actions.includes("tool_call"), true, template.id);
    assert.deepEqual(template.tools, ["github"], template.id);
    assert.ok(Number(template.dailyBudgetUsd) > 0 && Number(template.monthlyBudgetUsd) >= Number(template.dailyBudgetUsd), template.id);
    assert.match(template.soulMd, /untrusted data/, template.id);
  }
  assert.equal(getTemplate("pr-reviewer")?.actions.includes("shell"), false);
  assert.equal(getTemplate("dev-agent")?.actions.includes("shell"), true);
  assert.equal(getTemplate("missing"), undefined);
});

test("the Blank form still defaults to deny tool_call and shell", () => {
  for (const action of ["tool_call", "shell"]) assert.equal(KNOWN_ACTIONS.includes(action), false, action);
});

test("the demo fixture is a real red build", async () => {
  const { sum } = await import("../fixtures/demo-red-build/src/sum.js");
  assert.notEqual(sum(2, 3), 5);
  assert.equal(sum(2, 3), 8);
});
