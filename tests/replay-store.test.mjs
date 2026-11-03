import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

// TASK-041 against a real Postgres: every migration, the production grants for the app role, signed receipts written by the
// real recorder, the compile and replay paths, and the four owner routes with a real session.
const docker = (args, input) => spawnSync("docker", args, { encoding: "utf8", input, timeout: 120000 });
const dockerUp = docker(["version", "--format", "{{.Server.Version}}"]).status === 0;
const name = `eclipse-replay-${randomBytes(6).toString("hex")}`;
const password = randomBytes(16).toString("hex");
const OWNER = randomUUID(); const OTHER_OWNER = randomUUID();
const AGENT = randomUUID(); const PAUSED_AGENT = randomUUID();
const SEED = randomBytes(32).toString("hex");
const TOKEN = "c".repeat(64); const CSRF = "d".repeat(64);
const ORIGIN = "http://127.0.0.1:3000";
const ARTIFACTS = mkdtempSync(path.join(tmpdir(), "eclipse-replay-"));
const ZERO = { input: 0, output: 0, cached: 0, reasoning: 0 };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZfJ8AAAAASUVORK5CYII=";
let admin; let pool; let app; let mods; let routes; let port;

const unwrap = (module) => module.default ?? module;

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
  // The runtime role exactly as scripts/db-migrate.mjs grants it, for the tables this task touches.
  await admin.query(`CREATE SCHEMA drizzle;
    REVOKE ALL ON SCHEMA drizzle FROM PUBLIC, eclipse_app; REVOKE CREATE, TEMP ON DATABASE postgres FROM PUBLIC, eclipse_app; GRANT USAGE ON SCHEMA public TO eclipse_app;
    GRANT SELECT, INSERT, UPDATE ON owner, agent_policies, runs TO eclipse_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON sessions, agents TO eclipse_app;
    GRANT SELECT, INSERT ON chat_sessions, messages, steps, step_evidence, checkpoints, cost_entries, run_meta TO eclipse_app;
    GRANT SELECT, INSERT, DELETE ON replay_scripts TO eclipse_app;
    GRANT SELECT, INSERT ON replay_script_versions TO eclipse_app;
    GRANT SELECT, INSERT, UPDATE ON replay_script_proposals TO eclipse_app;`);
  await admin.query("INSERT INTO owner(id, owner_id, login, password_hash, timezone) VALUES($1, $1, 'owner', 'hash', 'UTC')", [OWNER]);
  for (const [id, status] of [[AGENT, "active"], [PAUSED_AGENT, "paused"]]) {
    await admin.query("INSERT INTO agents(id, owner_id, name, role, soul_md, status, daily_budget_cents, monthly_budget_cents) VALUES($1, $2, 'Ada', 'Tester', 'soul', $3, 100, 1000)", [id, OWNER, status]);
    await admin.query("INSERT INTO agent_policies(agent_id, owner_id, actions) VALUES($1, $2, ARRAY['click','type','key','scroll','wait'])", [id, OWNER]);
  }
  await admin.query("INSERT INTO sessions(id, owner_id, token_hash, csrf_token, expires_at) VALUES($1, $2, $3, $4, now() + interval '1 hour')",
    [randomUUID(), OWNER, createHash("sha256").update(TOKEN).digest("hex"), CSRF]);

  // The routes use the app's own connection pool (db/client.ts), which this test cannot close. Give every pool an error
  // listener so removing the container at the end does not surface as an uncaught "connection terminated".
  for (const method of ["query", "connect"]) {
    const original = pg.Pool.prototype[method];
    pg.Pool.prototype[method] = function patched(...args) { if (!this.__quiet) { this.__quiet = true; this.on("error", () => {}); } return original.apply(this, args); };
  }  process.env.DATABASE_URL = `postgresql://eclipse_app:${password}@127.0.0.1:${port}/postgres`;
  process.env.APP_ORIGIN = ORIGIN;
  process.env.ARTIFACTS_DIR = ARTIFACTS;
  delete process.env.RECEIPT_SIGNING_KEY;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const schema = await import("../db/schema.ts");
  app = drizzle({ client: pool, schema: unwrap(schema) });
  mods = {
    store: unwrap(await import("../lib/replay/store.ts")), ports: unwrap(await import("../lib/replay/ports.ts")), runner: unwrap(await import("../lib/replay/runner.ts")),
    receipts: unwrap(await import("../lib/receipts/store.ts")), chain: unwrap(await import("../lib/receipts/chain.mjs")), signer: unwrap(await import("../lib/receipts/signer.ts")),
    evidence: unwrap(await import("../lib/receipts/evidence.ts")), checkpoints: unwrap(await import("../lib/checkpoints/store.ts")),
    history: unwrap(await import("../lib/receipts/history.ts")), costs: unwrap(await import("../lib/costs/store.ts")),
  };
  routes = {
    compile: unwrap(await import("../app/api/runs/[runId]/replay-script/route.ts")), list: unwrap(await import("../app/api/agents/[agentId]/replay-scripts/route.ts")),
    remove: unwrap(await import("../app/api/replay-scripts/[scriptId]/route.ts")), run: unwrap(await import("../app/api/replay-scripts/[scriptId]/run/route.ts")),
  };
});
test.after(async () => {
  await pool?.end().catch(() => {}); await admin?.end().catch(() => {});
  if (dockerUp) docker(["rm", "-f", "-v", name]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  rmSync(ARTIFACTS, { recursive: true, force: true });
});

const skip = !dockerUp && "Docker is not available";
const input = (idx, over = {}) => ({ idx, model: "m", model_label: "m", route: "main", action: { kind: "wait" }, target: null, grounding_method: null, methods: [],
  sam: "off", confidence: "medium", before_hash: null, after_hash: null, postcondition: "control_present: Apply filter", result: "pass", code: null, executed: true,
  usage: { ...ZERO }, cost_micro_usd: null, ...over });
const CLICK = { action: { kind: "click", target: "the download pdf link" }, target: { role: "link", name: "Download PDF" } };

async function record({ owner = OWNER, agent = AGENT, task = "Download the invoice", steps, status = "finished", seal = true }) {
  const recorder = mods.receipts.createReceiptRecorder({ database: app, ownerId: owner, agentId: agent, agentName: "Ada", task, signer: mods.signer.loadReceiptSigner(SEED) });
  await recorder.begin();
  for (const [i, over] of steps.entries()) await recorder.step(input(i + 1, over));
  if (seal) await recorder.seal(status, ZERO);
  return recorder.runId;
}
const GOOD = [CLICK, { action: { kind: "scroll", direction: "down" } }, {}];

const headers = (over = {}) => ({ Cookie: `eclipse_session=${TOKEN}`, Origin: ORIGIN, "Content-Type": "application/json", "x-csrf-token": CSRF, ...over });
const call = (handler, url, init = {}, params = {}) => handler(new Request(`${ORIGIN}${url}`, { headers: headers(), ...init }), { params: Promise.resolve(params) });
const post = (handler, url, body, params, over) => call(handler, url, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: headers(over) }, params);

test("compiling a finished, chain-verified run stores a script once; the same run returns the same script", { skip }, async () => {
  const runId = await record({ steps: GOOD });
  const first = await mods.store.compileRun(app, OWNER, runId);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.created, true);
  assert.equal(first.script.name, "Download the invoice");
  assert.deepEqual(first.script.steps.map((s) => [s.idx, s.action]), [[1, "click"], [2, "scroll"], [3, "wait"]]);
  assert.deepEqual(first.script.steps[0], { idx: 1, action: "click", role: "link", name: "Download PDF", expect: "control_present: Apply filter" });
  const again = await mods.store.compileRun(app, OWNER, runId, "Another name");
  assert.deepEqual([again.ok, again.created, again.script.id, again.script.name], [true, false, first.script.id, "Download the invoice"]);
  assert.equal((await admin.query("SELECT count(*)::int n FROM replay_scripts WHERE source_run_id = $1", [runId])).rows[0].n, 1);
  const named = await mods.store.compileRun(app, OWNER, await record({ steps: GOOD }), "Monthly invoice");
  assert.equal(named.script.name, "Monthly invoice");
});

test("a run that is not finished, not intact, or not replayable without a model is refused with fixed reasons", { skip }, async () => {
  const refused = async (runId, owner = OWNER) => mods.store.compileRun(app, owner, runId);
  const stopped = await refused(await record({ steps: GOOD, status: "needs_owner" }));
  assert.deepEqual([stopped.ok, stopped.reasons], [false, [{ step: null, code: "run_not_verified" }]]);
  const open = await refused(await record({ steps: GOOD, seal: false }));
  assert.deepEqual(open.reasons, [{ step: null, code: "chain_invalid" }]);

  const tampered = await record({ steps: GOOD });
  await admin.query("UPDATE steps SET receipt_json = replace(receipt_json, 'scroll', 'wait') WHERE run_id = $1 AND idx = 2", [tampered]);
  assert.deepEqual((await refused(tampered)).reasons, [{ step: null, code: "chain_invalid" }]);

  assert.deepEqual((await refused(await record({ steps: [CLICK, { result: "fail" }] }))).reasons, [{ step: 2, code: "step_not_verified" }]);
  assert.deepEqual((await refused(await record({ steps: [{ action: { kind: "read_document", name: "a.pdf", offset: 0 }, result: "executed" }] }))).reasons, [{ step: 1, code: "step_not_replayable" }]);
  assert.deepEqual((await refused(await record({ steps: [CLICK, { postcondition: "the invoice downloads" }] }))).reasons, [{ step: 2, code: "postcondition_not_structural" }]);
  assert.deepEqual((await refused(await record({ steps: [] }))).reasons, [{ step: null, code: "no_steps" }]);
  assert.deepEqual((await refused(await record({ steps: Array.from({ length: 21 }, () => ({})) }))).reasons, [{ step: null, code: "too_many_steps" }]);
  assert.equal((await admin.query("SELECT count(*)::int n FROM replay_scripts WHERE source_run_id = ANY($1)", [[tampered]])).rows[0].n, 0);

  // Another owner's run and an unknown run look the same.
  const foreign = await record({ owner: OTHER_OWNER, steps: GOOD });
  assert.deepEqual(await refused(foreign), { ok: false, error: "run_not_found" });
  assert.deepEqual(await refused(randomUUID()), { ok: false, error: "run_not_found" });
});

test("scripts are owner-scoped, and the runtime role can create and delete them but never edit one", { skip }, async () => {
  const compiled = await mods.store.compileRun(app, OWNER, await record({ steps: GOOD }));
  const id = compiled.script.id;
  assert.equal((await mods.store.getScript(app, OWNER, id))?.id, id);
  assert.equal(await mods.store.getScript(app, OTHER_OWNER, id), null);
  assert.deepEqual(await mods.store.listScripts(app, OTHER_OWNER, AGENT), []);
  assert.ok((await mods.store.listScripts(app, OWNER, AGENT)).some((script) => script.id === id));
  assert.equal(await mods.store.deleteScript(app, OTHER_OWNER, id), false);
  await assert.rejects(() => pool.query("UPDATE replay_scripts SET name = 'edited'"), /permission denied/);
  await assert.rejects(() => pool.query("UPDATE replay_scripts SET steps = '[]'::jsonb"), /permission denied/);
  await assert.rejects(() => pool.query("TRUNCATE replay_scripts"), /permission denied/);
  await assert.rejects(() => pool.query("INSERT INTO replay_scripts(id, owner_id, agent_id, source_run_id, name, steps, step_count) VALUES (gen_random_uuid(), $1, $2, $3, '', '[]', 1)", [OWNER, AGENT, compiled.script.sourceRunId]), /duplicate key|check constraint/);
  assert.equal(await mods.store.deleteScript(app, OWNER, id), true);
  assert.equal(await mods.store.deleteScript(app, OWNER, id), false);
  assert.equal((await admin.query("SELECT count(*)::int n FROM runs WHERE id = $1", [compiled.script.sourceRunId])).rows[0].n, 1, "the proof stays");
  // A damaged stored script is never replayed.
  const damaged = await mods.store.compileRun(app, OWNER, await record({ steps: GOOD }));
  await admin.query("UPDATE replay_scripts SET steps = '[{\"idx\":1,\"action\":\"click\",\"x\":5}]'::jsonb WHERE id = $1", [damaged.script.id]);
  assert.equal(await mods.store.getScript(app, OWNER, damaged.script.id), null);
});

function desktopFor(layout) {
  const calls = [];
  const controls = layout === "A"
    ? [{ ref: 1, role: "link", name: "Download PDF", tag: "a", x: 100, y: 100, width: 80, height: 30 }, { ref: 2, role: "button", name: "Apply filter", tag: "button", x: 100, y: 160, width: 80, height: 30 }]
    : [{ ref: 1, role: "link", name: "Get invoice", tag: "a", x: 100, y: 100, width: 80, height: 30 }];
  return { calls,
    screenshot: async () => ({ base64: PNG, width: 1024, height: 768 }),
    snapshot: async () => ({ href: "https://vendor.example/", title: "Vendor", frames: 0, controls }),
    verify: async ({ kind, value }) => ({ status: kind === "control_present" && controls.some((c) => c.name === value) ? "pass" : "fail", code: "checked" }),
    click: async (x, y) => { calls.push(["click", x, y]); }, type: async () => { calls.push(["type"]); }, key: async (k) => { calls.push(["key", k]); },
    scroll: async (d) => { calls.push(["scroll", d]); } };
}
const portsFor = (desktop) => ({
  ...mods.ports.createReplayPorts(app),
  async prepare(ownerId, agentId) {
    const signer = mods.signer.loadReceiptSigner(SEED); const runId = randomUUID();
    return { ok: true, persona: { id: agentId, name: "Ada", actions: ["click", "type", "key", "scroll", "wait"] }, desktop,
      receipts: (task) => mods.receipts.createReceiptRecorder({ database: app, ownerId, agentId, agentName: "Ada", task, signer, runId }),
      evidence: () => mods.evidence.createEvidenceRecorder({ database: app, ownerId, runId }),
      checkpoints: () => mods.checkpoints.createCheckpointRecorder({ database: app, ownerId, runId, desktop }),
      approvals: async () => "allowed" };
  },
});
const lastCard = async () => (await admin.query("SELECT content, run_id FROM messages ORDER BY created_at DESC LIMIT 1")).rows[0];

test("a replay with real recorders leaves a sealed, verifiable, zero-cost run; a changed site stops it and is not replayable", { skip }, async () => {
  const script = (await mods.store.compileRun(app, OWNER, await record({ steps: GOOD }))).script;
  const desktop = desktopFor("A");
  assert.equal(await mods.ports.runSavedReplay(OWNER, script, new Map(), portsFor(desktop)), "started");
  assert.deepEqual(desktop.calls, [["click", 140, 115], ["scroll", "down"]]);
  const card = await lastCard();
  assert.match(card.content.text, /^Replay finished: 3 steps checked, no model used\.$/);
  const runId = card.run_id;
  assert.ok(runId, "the card is linked to the replay run");

  const exported = await mods.receipts.loadRunExport(app, OWNER, runId);
  const verdict = mods.chain.verifyRunExport(exported, { pinnedKeyId: mods.signer.loadReceiptSigner(SEED).keyId });
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  assert.equal(exported.seal.status, "finished");
  assert.deepEqual(exported.seal.usage, ZERO);
  assert.equal(JSON.parse(exported.header).task, `Replay: ${script.name}`);

  const detail = await mods.history.loadRunDetail(app, OWNER, runId);
  assert.deepEqual([detail.run.label, detail.run.verified, detail.chain.state], ["Verified", true, "verified"]);
  assert.deepEqual(detail.steps.map((s) => [s.model, s.result, s.confidence, s.costMicroUsd]), [["No model", "pass", "medium", 0], ["No model", "pass", "medium", 0], ["No model", "pass", "medium", 0]]);
  assert.deepEqual(detail.steps.map((s) => s.screens), ["stored", "stored", "stored"]);
  assert.deepEqual((await admin.query("SELECT idx FROM checkpoints WHERE run_id = $1 ORDER BY idx", [runId])).rows.map((r) => r.idx), [0, 1, 2, 3]);

  const cost = await mods.costs.loadRunCostReceipt(app, OWNER, runId);
  assert.equal(cost.totals.calls, 0);
  assert.equal(cost.totals.costMicroUsd, 0);
  assert.equal((await admin.query("SELECT count(*)::int n FROM cost_entries WHERE run_id = $1", [runId])).rows[0].n, 0);

  // The same flow on a changed site: layout B has no "Download PDF".
  const changed = desktopFor("B");
  await mods.ports.runSavedReplay(OWNER, script, new Map(), portsFor(changed));
  assert.deepEqual(changed.calls, [], "nothing was clicked");
  const stopped = await lastCard();
  assert.equal(stopped.content.text, "Replay stopped at step 1: the control this step needs is not on the page. Take over or ask me to redo it.");
  const stoppedDetail = await mods.history.loadRunDetail(app, OWNER, stopped.run_id);
  assert.deepEqual([stoppedDetail.run.label, stoppedDetail.run.verified, stoppedDetail.chain.state], ["Needs you", false, "verified"]);
  assert.deepEqual(stoppedDetail.steps.map((s) => [s.result, s.code]), [["blocked", "target_missing"]]);
  const again = await mods.store.compileRun(app, OWNER, stopped.run_id);
  assert.deepEqual(again.reasons, [{ step: null, code: "run_not_verified" }]);
});

test("routes: anonymous, wrong Origin, wrong CSRF, bad ids and bad bodies are denied before any work", { skip }, async () => {
  const runId = await record({ steps: GOOD });
  const url = `/api/runs/${runId}/replay-script`; const params = { runId };
  for (const handler of [
    () => routes.compile.POST(new Request(`${ORIGIN}${url}`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } }), { params: Promise.resolve(params) }),
    () => routes.list.GET(new Request(`${ORIGIN}/api/agents/${AGENT}/replay-scripts`), { params: Promise.resolve({ agentId: AGENT }) }),
    () => routes.remove.DELETE(new Request(`${ORIGIN}/api/replay-scripts/${runId}`, { method: "DELETE" }), { params: Promise.resolve({ scriptId: runId }) }),
    () => routes.run.POST(new Request(`${ORIGIN}/api/replay-scripts/${runId}/run`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } }), { params: Promise.resolve({ scriptId: runId }) }),
  ]) assert.equal((await handler()).status, 401);
  assert.equal((await post(routes.compile.POST, url, {}, params, { Origin: "http://evil.test" })).status, 403);
  assert.equal((await post(routes.compile.POST, url, {}, params, { "x-csrf-token": "0".repeat(64) })).status, 403);
  assert.equal((await call(routes.remove.DELETE, `/api/replay-scripts/${runId}`, { method: "DELETE", headers: headers({ "x-csrf-token": "0".repeat(64) }) }, { scriptId: runId })).status, 403);
  assert.equal((await post(routes.run.POST, `/api/replay-scripts/${runId}/run`, {}, { scriptId: runId }, { Origin: "http://evil.test" })).status, 403);
  assert.equal((await post(routes.compile.POST, `${url}?x=1`, {}, params)).status, 400);
  assert.equal((await post(routes.compile.POST, "/api/runs/not-a-uuid/replay-script", {}, { runId: "not-a-uuid" })).status, 400);
  for (const bad of [{ name: "" }, { name: "a\u0000b" }, { name: "x".repeat(81) }, { name: 5 }, { ownerId: OTHER_OWNER }, { name: "ok", extra: 1 }, "not json", "[]"])
    assert.equal((await post(routes.compile.POST, url, bad, params)).status, 400, JSON.stringify(bad));
  assert.equal((await post(routes.compile.POST, url, "{}", params, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await admin.query("SELECT count(*)::int n FROM replay_scripts WHERE source_run_id = $1", [runId])).rows[0].n, 0, "nothing was created by a denied call");
});

test("routes: save, list, delete and the not-replayable and not-found answers", { skip }, async () => {
  const runId = await record({ steps: GOOD }); const params = { runId }; const url = `/api/runs/${runId}/replay-script`;
  const created = await post(routes.compile.POST, url, { name: "Monthly invoice" }, params);
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("cache-control"), "no-store");
  const body = await created.json();
  assert.deepEqual([body.created, body.script.name, body.script.stepCount, body.script.sourceRunId], [true, "Monthly invoice", 3, runId]);
  assert.deepEqual(body.script.steps, [{ idx: 1, text: "Click link “Download PDF”", needsText: false }, { idx: 2, text: "Scroll down", needsText: false }, { idx: 3, text: "Wait", needsText: false }]);
  assert.equal(JSON.stringify(body).includes("owner_id"), false);
  const repeat = await post(routes.compile.POST, url, {}, params);
  assert.deepEqual([repeat.status, (await repeat.json()).script.id], [200, body.script.id]);

  const listed = await (await call(routes.list.GET, `/api/agents/${AGENT}/replay-scripts`, {}, { agentId: AGENT })).json();
  assert.ok(listed.scripts.some((s) => s.id === body.script.id));
  assert.deepEqual((await (await call(routes.list.GET, `/api/agents/${randomUUID()}/replay-scripts`, {}, { agentId: randomUUID() })).json()).scripts, []);
  assert.equal((await call(routes.list.GET, `/api/agents/${AGENT}/replay-scripts?x=1`, {}, { agentId: AGENT })).status, 400);

  const badRun = await record({ steps: [CLICK, { postcondition: "looks fine" }] });
  const notReplayable = await post(routes.compile.POST, `/api/runs/${badRun}/replay-script`, {}, { runId: badRun });
  assert.equal(notReplayable.status, 422);
  assert.deepEqual(await notReplayable.json(), { error: "not_replayable", reasons: [{ step: 2, code: "postcondition_not_structural" }] });
  const missing = randomUUID();
  assert.equal((await post(routes.compile.POST, `/api/runs/${missing}/replay-script`, {}, { runId: missing })).status, 404);
  const foreign = await record({ owner: OTHER_OWNER, steps: GOOD });
  assert.equal((await post(routes.compile.POST, `/api/runs/${foreign}/replay-script`, {}, { runId: foreign })).status, 404, "another owner's run");

  assert.equal((await call(routes.remove.DELETE, `/api/replay-scripts/${body.script.id}`, { method: "DELETE" }, { scriptId: body.script.id })).status, 200);
  assert.equal((await call(routes.remove.DELETE, `/api/replay-scripts/${body.script.id}`, { method: "DELETE" }, { scriptId: body.script.id })).status, 404);
  assert.equal((await call(routes.remove.DELETE, "/api/replay-scripts/nope", { method: "DELETE" }, { scriptId: "nope" })).status, 400);
});

test("routes: running a script checks the script, the values and the agent before it starts anything", { skip }, async () => {
  const typed = await record({ steps: [CLICK, { action: { kind: "type", chars: 4 }, postcondition: "control_present: Apply filter" }, {}] });
  const withType = (await mods.store.compileRun(app, OWNER, typed)).script;
  const plain = (await mods.store.compileRun(app, OWNER, await record({ steps: GOOD }))).script;
  const paused = (await mods.store.compileRun(app, OWNER, await record({ agent: PAUSED_AGENT, steps: GOOD }))).script;
  const run = (script, body, over, id = script.id) => post(routes.run.POST, `/api/replay-scripts/${id}/run`, body, { scriptId: id }, over);
  const messages = async () => (await admin.query("SELECT count(*)::int n FROM messages")).rows[0].n;
  const before = await messages();

  const unknown = randomUUID();
  assert.equal((await run(withType, {}, {}, unknown)).status, 404);
  assert.equal((await run(withType, {})).status, 400, "a type step needs its text");
  assert.equal((await run(withType, { inputs: {} })).status, 400);
  assert.equal((await run(withType, { inputs: { 2: "text", 1: "extra" } })).status, 400, "no value for a step that takes none");
  assert.equal((await run(withType, { inputs: { 2: "" } })).status, 400);
  assert.equal((await run(withType, { inputs: { 2: "a".repeat(2001) } })).status, 400);
  assert.equal((await run(withType, { inputs: { 2: "a\u0000b" } })).status, 400);
  assert.equal((await run(withType, { inputs: { 2: "text" }, ownerId: OTHER_OWNER })).status, 400);
  assert.equal((await run(plain, { inputs: { 1: "no step takes text" } })).status, 400);
  assert.equal((await run(paused, {})).status, 409, "a paused agent");
  assert.equal((await run(plain, "{")).status, 400);
  assert.equal(await messages(), before, "none of those started a run");

  const started = await run(plain, {});
  assert.equal(started.status, 202);
  assert.deepEqual(await started.json(), { status: "started" });
  // No RECEIPT_SIGNING_KEY here, so the run explains itself in chat instead of acting without proof.
  let card;
  for (let i = 0; i < 40 && !card; i++) {
    card = (await admin.query("SELECT content FROM messages WHERE content->>'text' LIKE '%receipt signing is not set up%'")).rows[0];
    if (!card) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(card, "the agent says why it can't run");
});
