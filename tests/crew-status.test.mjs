import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { loadCrewStatus } from "../lib/crew/status.ts";
import { cleanupCrewDatabase, createCrewDatabase, insertAgent, insertOwner } from "./crew-db.mjs";

const handle = await createCrewDatabase();
test.after(() => cleanupCrewDatabase(handle));

let owner;
test.before(async () => { if (!handle.skip) owner = await insertOwner(handle.adminPool, randomUUID(), "Asia/Kolkata"); });

async function resetStatus() {
  for (const table of ["approvals", "cost_entries", "steps", "run_meta", "runs", "agent_policies", "agents", "model_roles", "providers"]) {
    await handle.adminPool.query(`DELETE FROM ${table} WHERE owner_id=$1`, [owner]);
  }
}

const NOW = new Date("2026-11-03T06:00:00.000Z");
const GENERATION = randomUUID();

async function providerAndModel(ownerId, model = "muse-spark-1.3") {
  const providerId = randomUUID();
  await handle.adminPool.query(`INSERT INTO providers(id, owner_id, kind, base_url, enabled) VALUES ($1,$2,'openai-compatible','http://local',true)`, [providerId, ownerId]);
  await handle.adminPool.query(`INSERT INTO model_roles(id, owner_id, role, provider_id, model, use_main_key, mode, routing)
    VALUES ($1,$2,'main',$3,$4,false,'active','fixed')`, [randomUUID(), ownerId, providerId, model]);
}

async function unsealedRun(ownerId, agentId, { startedAt, heartbeatAt, task = "Open settings", agentName = "Briefer" } = {}) {
  const runId = randomUUID();
  await handle.adminPool.query(`INSERT INTO runs(id, owner_id, agent_id, header_json, header_hash, key_id, public_key, started_at, status, heartbeat_at)
    VALUES ($1,$2,$3,$4,$5,'kid','pub',$6,'running',$7)`, [
    runId, ownerId, agentId, JSON.stringify({ agent_name: agentName, task }), "a".repeat(64), startedAt, heartbeatAt,
  ]);
  return runId;
}

async function addStep(ownerId, runId, idx) {
  await handle.adminPool.query(`INSERT INTO steps(id, owner_id, run_id, idx, receipt_json, receipt_hash, prev_hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), ownerId, runId, idx, JSON.stringify({ result: "pass" }), "b".repeat(64), "c".repeat(64)]);
}

async function addCost(ownerId, agentId, costMicroUsd, createdAt, runId, callIndex = 1) {
  await handle.adminPool.query(`INSERT INTO cost_entries(id, owner_id, run_id, agent_id, provider_id, call_index, model, tokens_in, tokens_out, tokens_cached, cost_micro_usd, outcome, idempotency_key, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,'m',10,2,0,$7,'ok',$8,$9)`, [
    randomUUID(), ownerId, runId, agentId, randomUUID(), callIndex, costMicroUsd, `cost:${runId}:${callIndex}`, createdAt,
  ]);
}

test("Mission Control is owner-scoped and uses fresh heartbeats, real steps and local-day spend", { skip: handle.skip }, async () => {
  await resetStatus();
  const other = randomUUID();
  const briefer = await insertAgent(handle.adminPool, owner, { name: "Briefer", attention: "approval_pending" });
  const paused = await insertAgent(handle.adminPool, owner, { name: "Paused", status: "paused" });
  const stranger = await insertAgent(handle.adminPool, other, { name: "Stranger" });
  await providerAndModel(owner, "muse-spark-1.3");

  const activeRun = await unsealedRun(owner, briefer, { startedAt: new Date(NOW.getTime() - 5 * 60_000), heartbeatAt: new Date(NOW.getTime() - 10_000) });
  await addStep(owner, activeRun, 1);
  await addStep(owner, activeRun, 2);
  await addStep(owner, activeRun, 3);
  await addCost(owner, briefer, 500, new Date(NOW.getTime() - 60 * 60_000), activeRun, 1);
  await addCost(owner, briefer, 300, new Date(NOW.getTime() - 2 * 60_000), activeRun, 2);
  const oldRun = await unsealedRun(owner, briefer, { startedAt: new Date(NOW.getTime() - 26 * 60 * 60_000), heartbeatAt: new Date(NOW.getTime() - 25 * 60 * 60_000) });
  await addCost(owner, briefer, 900, new Date(NOW.getTime() - 25 * 60 * 60_000), oldRun);
  const strangerRun = await unsealedRun(other, stranger, { startedAt: new Date(NOW.getTime() - 2 * 60 * 60_000), heartbeatAt: new Date(NOW.getTime() - 60_000) });
  await addCost(other, stranger, 7000, new Date(NOW.getTime() - 60 * 60_000), strangerRun);
  const staleRun = await unsealedRun(owner, paused, { startedAt: new Date(NOW.getTime() - 60 * 60_000), heartbeatAt: new Date(NOW.getTime() - 10 * 60_000) });
  await addCost(owner, paused, 100, new Date(NOW.getTime() - 30 * 60_000), staleRun);
  await handle.adminPool.query(`INSERT INTO approvals(id, owner_id, agent_id, run_id, action_class, control_name, state)
    VALUES ($1,$2,$3,$4,'send','Send invoice','pending')`, [randomUUID(), owner, briefer, activeRun]);

  const calls = [];
  const desktop = async (agentId, _ownerId, operation) => {
    calls.push({ agentId, operation });
    if (agentId === briefer) return { agentId, state: "running", sandbox: "running", graphics: "running", browser: "running", generation: GENERATION };
    throw new Error("desktop offline");
  };
  const view = await loadCrewStatus(handle.app, owner, "Asia/Kolkata", NOW, desktop);

  assert.deepEqual(view.agents.map((agent) => agent.name), ["Briefer", "Paused"]);
  const first = view.agents[0];
  assert.equal(first.currentRun?.runId, activeRun);
  assert.equal(first.currentRun?.stepCount, 3);
  assert.equal(first.currentRun?.costMicroUsd, 800);
  assert.equal(first.todayCostMicroUsd, 800, "only cost inside the owner's local day is counted");
  assert.equal(first.desktop, "running");
  assert.equal(first.streamGeneration, GENERATION);
  assert.equal(first.attention, "approval_pending");
  assert.equal(first.pendingApprovals, 1);
  assert.equal(first.model, "muse-spark-1.3");
  assert.equal(view.agents[1].currentRun, null, "a stale heartbeat is not a live run");
  assert.equal(view.agents[1].todayCostMicroUsd, 100);
  assert.equal(view.agents[1].desktop, "stopped", "a paused agent never asks the desktop");
  assert.equal(view.totals.todayCostMicroUsd, 900);
  assert.equal(view.totals.running, 1);
  assert.equal(view.totals.needsYou, 1);
  assert.equal(view.timezone, "Asia/Kolkata");
  assert.equal(new Date(view.dayStart).toISOString(), "2026-11-02T18:30:00.000Z");
  assert.equal(new Date(view.dayEnd).toISOString(), "2026-11-03T18:30:00.000Z");
  assert.deepEqual(calls.map((call) => call.operation), ["session.status"]);
  assert.equal(calls.some((call) => call.agentId === paused), false);

  const otherView = await loadCrewStatus(handle.app, other, "UTC", NOW, desktop);
  assert.deepEqual(otherView.agents.map((agent) => agent.name), ["Stranger"]);
  assert.equal(otherView.totals.todayCostMicroUsd, 7000);
});

test("status survives a desktop error and keeps every owner agent listed", { skip: handle.skip }, async () => {
  await resetStatus();
  await insertAgent(handle.adminPool, owner, { name: "Alpha" });
  await insertAgent(handle.adminPool, owner, { name: "Beta" });
  const view = await loadCrewStatus(handle.app, owner, "UTC", NOW, async () => { throw new Error("offline"); });
  assert.equal(view.agents.length, 2);
  assert.deepEqual(view.agents.map((agent) => agent.desktop), ["unavailable", "unavailable"]);
  assert.deepEqual(view.agents.map((agent) => agent.currentRun), [null, null]);
});
