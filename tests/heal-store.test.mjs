import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

// TASK-044 against a real Postgres: every migration, the production grants for the new tables, the proposal lifecycle, the
// repair run, and the review routes with a real session.
const docker = (args, input) => spawnSync("docker", args, { encoding: "utf8", input, timeout: 120000 });
const dockerUp = docker(["version", "--format", "{{.Server.Version}}"]).status === 0;
const name = `eclipse-heal-${randomBytes(6).toString("hex")}`;
const password = randomBytes(16).toString("hex");
const OWNER = randomUUID(); const OTHER_OWNER = randomUUID();
const AGENT = randomUUID();
const SEED = randomBytes(32).toString("hex");
const TOKEN = "c".repeat(64); const OTHER_TOKEN = "e".repeat(64);
const CSRF = "d".repeat(64);
const ORIGIN = "http://127.0.0.1:3000";
const ZERO = { input: 0, output: 0, cached: 0, reasoning: 0 };
let admin; let pool; let app; let mods; let routes; let port;
let script; let failedRunId;

const unwrap = (module) => module.default ?? module;
const click = (name) => ({ action: { kind: "click", target: `the ${name} control` }, target: { role: "link", name } });
const replayClick = (idx, name) => ({ idx, action: "click", role: "link", name, expect: "control_present: Apply filter" });
const receiptInput = (idx, over = {}) => ({
  idx, model: "m", model_label: "m", route: "main", action: { kind: "wait" }, target: null, grounding_method: null, methods: [],
  sam: "off", confidence: "medium", before_hash: null, after_hash: null, postcondition: "control_present: Apply filter",
  result: "pass", code: null, executed: true, usage: { ...ZERO }, cost_micro_usd: null, ...over,
});

test.before(async () => {
  if (!dockerUp) return;
  const started = docker(["run", "-d", "--name", name, "-e", `POSTGRES_PASSWORD=${password}`, "-p", "127.0.0.1::5432",
    "postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b"]);
  assert.equal(started.status, 0, started.stderr);
  for (let i = 0; i < 40; i++) {
    if (docker(["exec", name, "pg_isready", "-U", "postgres", "-h", "127.0.0.1"]).status === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  port = Number(docker(["port", name, "5432/tcp"]).stdout.trim().split(":").pop());
  for (let i = 0; i < 40 && !admin; i++) {
    const candidate = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", password, database: "postgres" });
    try { await candidate.query("select 1"); admin = candidate; } catch { await candidate.end().catch(() => {}); await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
  assert.ok(admin, "database became reachable");
  // Migration 0019 grants pgboss privileges to the runtime role, so it must exist before the journal runs.
  await admin.query(`CREATE ROLE eclipse_app LOGIN PASSWORD '${password}'; REVOKE CREATE ON SCHEMA public FROM PUBLIC;`);
  const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) await admin.query(readFileSync(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""));
  await admin.query(`CREATE SCHEMA drizzle;
    REVOKE ALL ON SCHEMA drizzle FROM PUBLIC, eclipse_app; REVOKE CREATE, TEMP ON DATABASE postgres FROM PUBLIC, eclipse_app; GRANT USAGE ON SCHEMA public TO eclipse_app;
    GRANT SELECT, INSERT, UPDATE ON owner, agent_policies, runs TO eclipse_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON sessions, agents TO eclipse_app;
    GRANT SELECT, INSERT ON chat_sessions, messages, steps, step_evidence, checkpoints, cost_entries TO eclipse_app;
    GRANT SELECT, INSERT, DELETE ON replay_scripts TO eclipse_app;
    GRANT SELECT, INSERT ON replay_script_versions TO eclipse_app;
    GRANT SELECT, INSERT, UPDATE ON replay_script_proposals TO eclipse_app;`);
  for (const [id, login] of [[OWNER, "owner"]]) {
    await admin.query("INSERT INTO owner(id, owner_id, login, password_hash, timezone) VALUES($1, $1, $2, 'hash', 'UTC')", [id, login]);
  }
  await admin.query("INSERT INTO agents(id, owner_id, name, role, soul_md, status, daily_budget_cents, monthly_budget_cents) VALUES($1, $2, 'Ada', 'Tester', 'soul', 'active', 100, 1000)", [AGENT, OWNER]);
  await admin.query("INSERT INTO agent_policies(agent_id, owner_id, actions) VALUES($1, $2, ARRAY['click','type','key','scroll','wait'])", [AGENT, OWNER]);
  await admin.query("INSERT INTO sessions(id, owner_id, token_hash, csrf_token, expires_at) VALUES($1, $2, $3, $4, now() + interval '1 hour')",
    [randomUUID(), OWNER, createHash("sha256").update(TOKEN).digest("hex"), CSRF]);
  for (const method of ["query", "connect"]) {
    const original = pg.Pool.prototype[method];
    pg.Pool.prototype[method] = function patched(...args) { if (!this.__quiet) { this.__quiet = true; this.on("error", () => {}); } return original.apply(this, args); };
  }
  process.env.DATABASE_URL = `postgresql://eclipse_app:${password}@127.0.0.1:${port}/postgres`;
  process.env.APP_ORIGIN = ORIGIN;
  delete process.env.RECEIPT_SIGNING_KEY;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const schema = await import("../db/schema.ts");
  app = drizzle({ client: pool, schema: unwrap(schema) });
  mods = {
    replayStore: unwrap(await import("../lib/replay/store.ts")),
    receipts: unwrap(await import("../lib/receipts/store.ts")),
    signer: unwrap(await import("../lib/receipts/signer.ts")),
    chain: unwrap(await import("../lib/receipts/chain.mjs")),
    healStore: unwrap(await import("../lib/heal/store.ts")),
    heal: unwrap(await import("../lib/heal/heal.ts")),
  };
  routes = {
    detail: unwrap(await import("../app/api/replay-proposals/[proposalId]/route.ts")),
    decision: unwrap(await import("../app/api/replay-proposals/[proposalId]/decision/route.ts")),
  };

  const baseRun = await recordRun({ task: "Download the invoice", steps: [click("Open portal"), click("Download PDF")] });
  const compiled = await mods.replayStore.compileRun(app, OWNER, baseRun);
  assert.equal(compiled.ok, true, JSON.stringify(compiled));
  script = compiled.script;
  failedRunId = await recordRun({
    task: "Replay: Download the invoice",
    steps: [click("Open portal"), { ...click("Download PDF"), result: "blocked", executed: false, code: "target_missing" }],
    status: "needs_owner",
  });
});

test.after(async () => {
  await pool?.end().catch(() => {}); await admin?.end().catch(() => {});
  if (dockerUp) docker(["rm", "-f", "-v", name]);
  await new Promise((resolve) => setTimeout(resolve, 300));
});

const skip = !dockerUp && "Docker is not available";

async function recordRun({ owner = OWNER, agent = AGENT, task, steps, status = "finished" }) {
  const recorder = mods.receipts.createReceiptRecorder({
    database: app, ownerId: owner, agentId: agent, agentName: "Ada", task, signer: mods.signer.loadReceiptSigner(SEED),
  });
  await recorder.begin();
  for (const [i, over] of steps.entries()) await recorder.step(receiptInput(i + 1, over));
  await recorder.seal(status, ZERO);
  return recorder.runId;
}

const headers = (over = {}) => ({ Cookie: `eclipse_session=${TOKEN}`, Origin: ORIGIN, "Content-Type": "application/json", "x-csrf-token": CSRF, ...over });
const call = (handler, url, init = {}, params = {}) => handler(new Request(`${ORIGIN}${url}`, { headers: headers(), ...init }), { params: Promise.resolve(params) });
const post = (handler, url, body, params, over) => call(handler, url, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: headers(over) }, params);

// A fake repair environment: prepare succeeds, run writes real signed receipts, and loadExport reads them back.
function healPorts({ runOutcome = "finished", runSteps = [click("Get invoice")], prepare = {} } = {}) {
  const cards = []; const tasks = []; const contexts = [];
  return {
    cards, tasks, contexts,
    async prepare() {
      if (prepare.reason) return { ok: false, reason: prepare.reason };
      return {
        ok: true,
        persona: { id: AGENT, name: "Ada", role: "Tester", soulMd: "soul", actions: ["click", "wait"] },
        timezone: "UTC", provider: {}, model: "m", hardModel: null, desktop: {},
        receipts: (task) => mods.receipts.createReceiptRecorder({
          database: app, ownerId: OWNER, agentId: AGENT, agentName: "Ada", task, signer: mods.signer.loadReceiptSigner(SEED),
        }),
        evidence: () => ({ record: async () => undefined }),
        checkpoints: () => ({ capture: async () => undefined }),
      };
    },
    async run(deps) {
      tasks.push(deps.task); contexts.push(deps.untrustedContext);
      if (runOutcome === "busy") return { outcome: "busy", steps: [], usage: ZERO, cardPosted: false };
      if (runOutcome !== "finished") return { outcome: runOutcome, steps: [], usage: ZERO, cardPosted: true };
      await deps.receipts.begin();
      for (const [i, over] of runSteps.entries()) await deps.receipts.step(receiptInput(i + 1, over));
      await deps.receipts.seal("finished", ZERO);
      await deps.postCard({ type: "message", text: "Repair finished." });
      return { outcome: "finished", steps: [], usage: ZERO, cardPosted: true };
    },
    async loadExport(ownerId, runId) { return mods.receipts.loadRunExport(app, ownerId, runId); },
    async postCard(ownerId, agentId, card, runId) { cards.push({ card, runId }); },
  };
}

const mismatch = (code, step = 2) => ({ outcome: "needs_owner", done: [1], stoppedAt: { step, code }, cardPosted: true });

test("a target_missing repair becomes a pending proposal; approval makes v2 the replay", { skip }, async () => {
  const ports = healPorts();
  const outcome = await mods.heal.maybeHeal(app, OWNER, script, mismatch("target_missing"), failedRunId, ports);
  assert.equal(outcome, "proposed");
  assert.match(ports.tasks[0], /stopped at step 2/);
  assert.match(ports.contexts[0], /Download PDF/);
  assert.equal(ports.tasks[0].includes("Download PDF"), false, "page labels stay out of the signed task");

  const card = ports.cards.find((entry) => entry.card.type === "skill_update")?.card;
  assert.ok(card, JSON.stringify(ports.cards));
  assert.equal(card.fromVersion, 1);
  assert.equal(card.toVersion, 2);
  assert.equal(card.failedStep, 2);
  assert.equal(card.changedSteps, 2);
  assert.equal(card.failureCode, "target_missing");

  const detail = await mods.healStore.buildProposalDetail(app, OWNER, card.proposalId);
  assert.ok(detail);
  assert.equal(detail.status, "pending");
  assert.equal(detail.scriptName, "Download the invoice");
  assert.deepEqual(detail.diff.map((row) => row.kind), ["same", "removed", "added"]);
  assert.match(detail.reason, /no longer on the page/);
  assert.equal(detail.stale, false);
  assert.equal(detail.canDecide, true);

  const decided = await mods.healStore.decideProposal(app, OWNER, card.proposalId, "approve");
  assert.equal(decided.ok, true);
  const updated = await mods.replayStore.getScript(app, OWNER, script.id);
  assert.equal(updated.version, 2);
  assert.deepEqual(updated.steps.map((step) => step.name ?? step.action), ["Open portal", "Get invoice"]);
  assert.equal(updated.pendingProposalId, null);
  const listed = (await mods.replayStore.listScripts(app, OWNER, AGENT)).find((row) => row.id === script.id);
  assert.equal(listed.version, 2);
  assert.equal(await mods.healStore.buildProposalDetail(app, OTHER_OWNER, card.proposalId), null);
});

test("non-site-change codes, typed steps, pending proposals, a missing model and a non-finished repair never propose", { skip }, async () => {
  assert.equal(await mods.heal.maybeHeal(app, OWNER, script, mismatch("input_missing"), failedRunId, healPorts()), "not_healable");
  assert.equal(await mods.heal.maybeHeal(app, OWNER, script, { ...mismatch("target_missing"), stoppedAt: null }, failedRunId, healPorts()), "not_healable");

  const typedRun = await recordRun({ task: "Typed routine", steps: [click("Open portal"), { action: { kind: "type", chars: 5 }, postcondition: "control_present: Apply filter" }] });
  const typed = await mods.replayStore.compileRun(app, OWNER, typedRun);
  assert.equal(typed.ok, true, JSON.stringify(typed));
  assert.equal(await mods.heal.maybeHeal(app, OWNER, typed.script, mismatch("target_missing", 2), failedRunId, healPorts()), "typed_step");

  // A pending proposal blocks another repair before any model call.
  const pendingRun = await recordRun({ task: "Pending routine", steps: [click("Open portal")] });
  const pendingScript = (await mods.replayStore.compileRun(app, OWNER, pendingRun)).script;
  const pending = await mods.healStore.createProposal(app, {
    ownerId: OWNER, agentId: AGENT, scriptId: pendingScript.id, baseVersion: 1, failedStep: 1, failureCode: "target_missing",
    replayRunId: failedRunId, healRunId: await recordRun({ task: "Repair pending", steps: [click("Open portal")] }), steps: pendingScript.steps,
  });
  assert.equal(pending.ok, true);
  assert.equal(await mods.heal.maybeHeal(app, OWNER, pendingScript, mismatch("target_missing", 1), failedRunId, healPorts()), "pending");

  // A script without a pending update reaches prepare and run.
  const freeRun = await recordRun({ task: "Free routine", steps: [click("Open portal")] });
  const freeScript = (await mods.replayStore.compileRun(app, OWNER, freeRun)).script;
  const noModel = healPorts({ prepare: { reason: "no_model" } });
  assert.equal(await mods.heal.maybeHeal(app, OWNER, freeScript, mismatch("target_missing", 1), failedRunId, noModel), "no_model");
  assert.ok(noModel.cards.some((entry) => entry.card.type === "message" && /Main AI model/.test(entry.card.text)));

  const stopped = healPorts({ runOutcome: "needs_owner" });
  assert.equal(await mods.heal.maybeHeal(app, OWNER, freeScript, mismatch("target_missing", 1), failedRunId, stopped), "not_finished");
});

test("a stale base is refused; a second decision and another owner change nothing", { skip }, async () => {
  const staleRun = await recordRun({ task: "Stale routine", steps: [click("Open portal")] });
  const staleScript = (await mods.replayStore.compileRun(app, OWNER, staleRun)).script;
  const first = await mods.healStore.createProposal(app, {
    ownerId: OWNER, agentId: AGENT, scriptId: staleScript.id, baseVersion: 1, failedStep: 1, failureCode: "target_missing",
    replayRunId: failedRunId, healRunId: await recordRun({ task: "First repair", steps: [click("Get invoice")] }), steps: [replayClick(1, "Get invoice")],
  });
  assert.equal(first.ok, true);
  assert.equal((await mods.healStore.decideProposal(app, OWNER, first.proposal.id, "approve")).ok, true);
  assert.equal((await mods.healStore.decideProposal(app, OWNER, first.proposal.id, "approve")).error, "already_decided");
  assert.equal((await mods.healStore.decideProposal(app, OTHER_OWNER, first.proposal.id, "approve")).error, "not_found");

  const second = await mods.healStore.createProposal(app, {
    ownerId: OWNER, agentId: AGENT, scriptId: staleScript.id, baseVersion: 1, failedStep: 1, failureCode: "target_missing",
    replayRunId: failedRunId, healRunId: await recordRun({ task: "Second repair", steps: [click("Get invoice")] }), steps: [replayClick(1, "Get invoice")],
  });
  assert.equal(second.error, "stale");
});

test("the review routes are owner-only, CSRF-checked and refuse a second decision", { skip }, async () => {
  const routeRun = await recordRun({ task: "Route routine", steps: [click("Open portal")] });
  const routeScript = (await mods.replayStore.compileRun(app, OWNER, routeRun)).script;
  const created = await mods.healStore.createProposal(app, {
    ownerId: OWNER, agentId: AGENT, scriptId: routeScript.id, baseVersion: 1, failedStep: 1, failureCode: "postcondition_failed",
    replayRunId: failedRunId, healRunId: await recordRun({ task: "Route repair", steps: [click("Get invoice")] }), steps: [replayClick(1, "Get invoice")],
  });
  assert.equal(created.ok, true);
  const id = created.proposal.id;
  const params = { proposalId: id };

  const anonymous = await routes.detail.GET(new Request(`${ORIGIN}/api/replay-proposals/${id}`, { headers: { Origin: ORIGIN } }), { params: Promise.resolve(params) });
  assert.equal(anonymous.status, 401);

  const detail = await call(routes.detail.GET, `/api/replay-proposals/${id}`, {}, params);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).proposal.status, "pending");

  const foreign = await routes.detail.GET(new Request(`${ORIGIN}/api/replay-proposals/${id}`, { headers: {
    Cookie: `eclipse_session=${OTHER_TOKEN}`, Origin: ORIGIN,
  } }), { params: Promise.resolve(params) });
  assert.equal(foreign.status, 401);

  const noCsrf = await post(routes.decision.POST, `/api/replay-proposals/${id}/decision`, { decision: "approve" }, params, { "x-csrf-token": "a".repeat(64) });
  assert.equal(noCsrf.status, 403);
  const extra = await post(routes.decision.POST, `/api/replay-proposals/${id}/decision`, { decision: "approve", extra: true }, params);
  assert.equal(extra.status, 400);

  const approved = await post(routes.decision.POST, `/api/replay-proposals/${id}/decision`, { decision: "approve" }, params);
  assert.equal(approved.status, 200);
  assert.equal((await approved.json()).proposal.status, "approved");
  const again = await post(routes.decision.POST, `/api/replay-proposals/${id}/decision`, { decision: "approve" }, params);
  assert.equal(again.status, 409);
});

test("versions are append-only for the app role; deleting a script cascades versions and proposals", { skip }, async () => {
  await assert.rejects(() => pool.query("UPDATE replay_script_versions SET step_count = 1"), /permission denied/);
  await assert.rejects(() => pool.query("DELETE FROM replay_script_versions"), /permission denied/);
  await assert.rejects(() => pool.query("DELETE FROM replay_script_proposals"), /permission denied/);

  const cascadeRun = await recordRun({ task: "Cascade routine", steps: [click("Open portal")] });
  const cascadeScript = (await mods.replayStore.compileRun(app, OWNER, cascadeRun)).script;
  const created = await mods.healStore.createProposal(app, {
    ownerId: OWNER, agentId: AGENT, scriptId: cascadeScript.id, baseVersion: 1, failedStep: 1, failureCode: "target_missing",
    replayRunId: failedRunId, healRunId: await recordRun({ task: "Cascade repair", steps: [click("Get invoice")] }), steps: [replayClick(1, "Get invoice")],
  });
  assert.equal(created.ok, true);
  assert.equal(await mods.replayStore.deleteScript(app, OWNER, cascadeScript.id), true);
  assert.equal((await admin.query("SELECT count(*)::int n FROM replay_script_proposals WHERE script_id = $1", [cascadeScript.id])).rows[0].n, 0);
  assert.equal((await admin.query("SELECT count(*)::int n FROM replay_script_versions WHERE script_id = $1", [cascadeScript.id])).rows[0].n, 0);
});
