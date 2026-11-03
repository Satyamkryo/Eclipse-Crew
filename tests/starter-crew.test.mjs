import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { AGENT_TEMPLATES } from "../lib/agents/templates.ts";
import { createOrResumeStarterCrew, getStarterCrew } from "../lib/crew/starter.ts";
import { cleanupCrewDatabase, createCrewDatabase, insertAgent, insertOwner } from "./crew-db.mjs";

const handle = await createCrewDatabase();
test.after(() => cleanupCrewDatabase(handle));

let owner;
test.before(async () => { if (!handle.skip) owner = await insertOwner(handle.adminPool); });

async function resetStarter() {
  for (const table of ["starter_crew_members", "starter_crew_setups", "agent_policies", "agents", "audit_log"]) {
    await handle.adminPool.query(`DELETE FROM ${table} WHERE owner_id=$1`, [owner]);
  }
}

function fakeDesktop({ fail = new Set(), delayMs = 0 } = {}) {
  const calls = [];
  const operations = [];
  return {
    calls, operations,
    desktopCreateAgent: async (agentId) => { calls.push(agentId); if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs)); if (fail.has(agentId)) throw new Error("desktop_down"); return { agentId }; },
    desktopDeleteAgent: async (agentId) => ({ agentId }),
    desktopSession: async (agentId, _ownerId, operation) => {
      operations.push(operation);
      return { agentId, state: "running", sandbox: "running", graphics: "running", browser: "running", generation: randomUUID() };
    },
  };
}

test("the starter preview is the six server-side roles, not caller input", () => {
  assert.equal(AGENT_TEMPLATES.length, 6);
  assert.deepEqual(AGENT_TEMPLATES.map((template) => template.id),
    ["pr-reviewer", "dev-agent", "daily-briefer", "inbox-triage", "research-analyst", "travel-assistant"]);
  for (const template of AGENT_TEMPLATES) {
    assert.ok(template.routineExamples.length > 0, template.id);
    assert.ok(template.soulMd.length <= 2000, template.id);
  }
});

test("one action creates six unique identities and a repeat resumes the same set", { skip: handle.skip }, async () => {
  await resetStarter();
  // A same-named agent that the owner made earlier must not be adopted as a starter member.
  const unrelated = await insertAgent(handle.adminPool, owner, { name: "Daily Briefer" });
  const desktop = fakeDesktop();

  const first = await createOrResumeStarterCrew(handle.app, owner, desktop);
  assert.equal(first.setup?.state, "complete");
  assert.deepEqual(first.members.map((member) => member.templateId), AGENT_TEMPLATES.map((template) => template.id));
  assert.equal(first.summary.created, 6);
  assert.equal(new Set(first.members.map((member) => member.agentId)).size, 6);
  assert.equal(first.members.some((member) => member.agentId === unrelated), false);

  const agents = await handle.adminPool.query("SELECT id, name, status FROM agents WHERE owner_id=$1", [owner]);
  assert.equal(agents.rows.length, 7, "the pre-existing agent is untouched and six new agents exist");
  assert.equal(agents.rows.find((row) => row.id === unrelated).status, "active");

  const before = first.members.map((member) => member.agentId).sort();
  const second = await createOrResumeStarterCrew(handle.app, owner, fakeDesktop());
  assert.deepEqual(second.members.map((member) => member.agentId).sort(), before);
  const after = await handle.adminPool.query("SELECT count(*)::int AS count FROM agents WHERE owner_id=$1", [owner]);
  assert.equal(after.rows[0].count, 7, "a repeat creates no second crew");

  for (const template of AGENT_TEMPLATES) {
    const member = second.members.find((item) => item.templateId === template.id);
    const policy = await handle.adminPool.query("SELECT tools, domains, actions, memory_scopes FROM agent_policies WHERE owner_id=$1 AND agent_id=$2", [owner, member.agentId]);
    assert.deepEqual(policy.rows[0].tools, template.tools, template.id);
    assert.deepEqual(policy.rows[0].domains, template.domains, template.id);
    assert.deepEqual(policy.rows[0].actions, template.actions, template.id);
    assert.deepEqual(policy.rows[0].memory_scopes, template.memoryScopes, template.id);
    const agent = await handle.adminPool.query("SELECT daily_budget_cents, monthly_budget_cents FROM agents WHERE id=$1", [member.agentId]);
    assert.equal(agent.rows[0].daily_budget_cents, Math.round(Number(template.dailyBudgetUsd) * 100), template.id);
    assert.equal(agent.rows[0].monthly_budget_cents, Math.round(Number(template.monthlyBudgetUsd) * 100), template.id);
  }
});

test("one failed desktop keeps the paused identity and a retry reuses it", { skip: handle.skip }, async () => {
  await resetStarter();
  // A deterministic failure on the daily briefer's desktop step.
  const freshOwner = owner;
  const failing = fakeDesktop();
  const preview = await createOrResumeStarterCrew(handle.app, freshOwner, {
    ...failing,
    desktopCreateAgent: async (agentId) => {
      // The member UUIDs are allocated inside the service; fail the third template after it is claimed.
      const members = await handle.adminPool.query("SELECT template_id FROM starter_crew_members WHERE owner_id=$1 AND agent_id=$2", [freshOwner, agentId]);
      if (members.rows[0]?.template_id === "daily-briefer") throw new Error("desktop_down");
      return { agentId };
    },
  });
  assert.equal(preview.setup?.state, "partial");
  assert.equal(preview.summary.created, 5);
  assert.equal(preview.summary.failed, 1);
  const failed = preview.members.find((member) => member.state === "failed");
  assert.equal(failed.errorCode, "desktop_setup_failed");
  const kept = await handle.adminPool.query("SELECT status FROM agents WHERE id=$1 AND owner_id=$2", [failed.agentId, freshOwner]);
  assert.equal(kept.rows[0].status, "paused", "the failed identity is preserved paused");

  const retried = await createOrResumeStarterCrew(handle.app, freshOwner, fakeDesktop());
  assert.equal(retried.setup?.state, "complete");
  assert.equal(retried.members.find((member) => member.templateId === failed.templateId).agentId, failed.agentId);
  const total = await handle.adminPool.query("SELECT count(*)::int AS count FROM agents WHERE owner_id=$1", [freshOwner]);
  assert.equal(total.rows[0].count, 6);
});

test("two simultaneous creates cannot duplicate members or identities", { skip: handle.skip }, async () => {
  await resetStarter();
  const [left, right] = await Promise.all([
    createOrResumeStarterCrew(handle.app, owner, fakeDesktop({ delayMs: 5 })),
    createOrResumeStarterCrew(handle.app, owner, fakeDesktop({ delayMs: 5 })),
  ]);
  const ids = new Set([...left.members, ...right.members].map((member) => member.agentId));
  assert.equal(ids.size, 6);
  const rows = await handle.adminPool.query("SELECT count(*)::int AS agents FROM agents WHERE owner_id=$1", [owner]);
  assert.equal(rows.rows[0].agents, 6);
  const members = await handle.adminPool.query("SELECT count(*)::int AS members FROM starter_crew_members WHERE owner_id=$1", [owner]);
  assert.equal(members.rows[0].members, 6);
  const setups = await handle.adminPool.query("SELECT count(*)::int AS setups FROM starter_crew_setups WHERE owner_id=$1", [owner]);
  assert.equal(setups.rows[0].setups, 1);
});

test("a crashed creating member is reclaimed only after it goes stale", { skip: handle.skip }, async () => {
  await resetStarter();
  const first = await createOrResumeStarterCrew(handle.app, owner, fakeDesktop());
  const member = first.members[0];
  await handle.adminPool.query("UPDATE starter_crew_members SET state='creating', error_code=NULL, updated_at=now() WHERE owner_id=$1 AND agent_id=$2", [owner, member.agentId]);

  const freshClaim = await createOrResumeStarterCrew(handle.app, owner, fakeDesktop());
  const freshState = await handle.adminPool.query("SELECT state FROM starter_crew_members WHERE owner_id=$1 AND agent_id=$2", [owner, member.agentId]);
  assert.equal(freshClaim.members.find((item) => item.agentId === member.agentId).state, "creating");
  assert.equal(freshState.rows[0].state, "creating", "a live claim is not stolen");

  await handle.adminPool.query("UPDATE starter_crew_members SET updated_at=now() - interval '2 minutes' WHERE owner_id=$1 AND agent_id=$2", [owner, member.agentId]);
  const resumed = await createOrResumeStarterCrew(handle.app, owner, fakeDesktop());
  assert.equal(resumed.members.find((item) => item.agentId === member.agentId).state, "created");
  assert.equal(resumed.setup?.state, "complete");
  const count = await handle.adminPool.query("SELECT count(*)::int AS count FROM agents WHERE owner_id=$1", [owner]);
  assert.equal(count.rows[0].count, 6);
});

test("getStarterCrew is owner-scoped and empty for an unrelated owner id", { skip: handle.skip }, async () => {
  await resetStarter();
  await createOrResumeStarterCrew(handle.app, owner, fakeDesktop());
  const otherView = await getStarterCrew(handle.app, randomUUID());
  assert.equal(otherView.setup, null);
  assert.deepEqual(otherView.members, []);
  assert.equal(otherView.summary.total, 0);
});
