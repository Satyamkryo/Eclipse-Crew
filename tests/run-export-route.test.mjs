import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { buildHeader, buildReceipt, buildRunExport, deriveKeys, sealRun } from "../lib/receipts/chain.mjs";

const unwrap = (module) => module.default ?? module;

test("the export route exposes only GET and refuses anonymous requests with safe headers", async () => {
  const route = unwrap(await import("../app/api/runs/[runId]/export/route.ts"));
  assert.equal(typeof route.GET, "function");
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(route[method], undefined, method);
  const runId = randomUUID();
  const response = await route.GET(new Request(`http://127.0.0.1:3000/api/runs/${runId}/export`), { params: Promise.resolve({ runId }) });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
});

// ---- real stack: disposable Compose project, real migrations, real session cookie, real route, real CLI ----
const dockerUp = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" }).status === 0;
const project = `eclipse030test${randomBytes(6).toString("hex")}`;
const bootstrap = randomBytes(24).toString("hex");
const appPassword = randomBytes(24).toString("hex");
const migratorPassword = randomBytes(24).toString("hex");
const seed = randomBytes(32).toString("hex");
const env = { ...process.env, COMPOSE_PROJECT_NAME: project, POSTGRES_BOOTSTRAP_PASSWORD: bootstrap, POSTGRES_APP_PASSWORD: appPassword,
  POSTGRES_MIGRATOR_PASSWORD: migratorPassword, DESKTOP_CONTROL_SECRET: randomBytes(32).toString("hex"), EGRESS_PROXY_SECRET: randomBytes(32).toString("hex"),
  ENCRYPTION_KEY: randomBytes(32).toString("hex"), RECEIPT_SIGNING_KEY: seed, APP_ORIGIN: "http://127.0.0.1:3000",
  DATABASE_URL: `postgresql://eclipse_app:${appPassword}@postgres:5432/eclipse`,
  MIGRATION_DATABASE_URL: `postgresql://eclipse_migrator:${migratorPassword}@postgres:5432/eclipse` };
const docker = (args, options = {}) => spawnSync("docker", args, { env, encoding: "utf8", timeout: 600000, ...options });
const compose = (...args) => docker(["compose", ...args]);
const checked = (result, description) => {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  for (const secret of [bootstrap, appPassword, migratorPassword, seed]) assert.ok(!output.includes(secret), `${description} leaked a secret`);
  assert.equal(result.status, 0, `${description}: ${output}`);
  return result.stdout.trim();
};
const labelled = (kind, args) => checked(docker([kind, "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`, ...args]), `list ${kind}`).split(/\r?\n/).filter(Boolean);
test.after(() => {
  if (!dockerUp) return;
  const containers = checked(docker(["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`]), "list containers").split(/\r?\n/).filter(Boolean);
  for (const container of containers) assert.equal(checked(docker(["inspect", "--format", '{{ index .Config.Labels "com.docker.compose.project" }}', container]), "verify container label"), project);
  checked(compose("down", "--volumes", "--remove-orphans"), "remove isolated project");
  const tag = `${project}-app:latest`;
  if (docker(["image", "inspect", tag]).status === 0) checked(docker(["image", "rm", tag]), "remove disposable image");
  void labelled;
});

const OWNER = randomUUID();
const OTHER = randomUUID();
const AGENT = randomUUID();
const TOKEN = randomBytes(32).toString("hex");
const keys = deriveKeys(seed);

function runExport(runId, count = 3) {
  const header = buildHeader({ runId, agentId: AGENT, agentName: "Ada", task: "Open the settings page.", startedAt: "2026-11-01T12:00:00.000Z", keyId: keys.keyId });
  const rows = []; let head = header.hash;
  for (let idx = 1; idx <= count; idx++) {
    const receipt = buildReceipt({ run_id: runId, idx, postcondition: `step ${idx}`, result: "pass" }, head);
    rows.push({ idx, receiptText: receipt.text, receiptHash: receipt.hash, prevHash: head }); head = receipt.hash;
  }
  const usage = { input: 3, output: 1, cached: 0, reasoning: 0 };
  const endedAt = "2026-11-01T12:01:00.000Z";
  const signature = sealRun(keys.privateKey, { runId, headerHash: header.hash, stepCount: count, headHash: head, status: "finished", endedAt, usage });
  return buildRunExport({ runId, headerText: header.text, headerHash: header.hash, keyId: keys.keyId, publicKey: keys.publicKey,
    seal: { status: "finished", endedAt, stepCount: count, headHash: head, usage, signature } }, rows);
}
const q = (text) => `$q$${text}$q$`;
function insertRun(psql, owner, exported) {
  const seal = exported.seal;
  psql(`INSERT INTO runs(id,owner_id,agent_id,header_json,header_hash,key_id,public_key,started_at,status,ended_at,step_count,head_hash,usage,signature) VALUES ('${exported.run_id}','${owner}','${AGENT}',${q(exported.header)},'${exported.header_hash}','${exported.key_id}','${exported.public_key}','2026-11-01T12:00:00.000Z','finished','${seal.ended_at}',${seal.step_count},'${seal.head_hash}','${JSON.stringify(seal.usage)}'::jsonb,'${seal.signature}')`);
  for (const step of exported.steps) {
    psql(`INSERT INTO steps(id,owner_id,run_id,idx,receipt_json,receipt_hash,prev_hash) VALUES ('${randomUUID()}','${owner}','${exported.run_id}',${step.idx},${q(step.receipt)},'${step.receipt_hash}','${step.prev_hash}')`);
  }
}

test("a real run is exported by the real route and verified by the real CLI", { skip: !dockerUp && "Docker is not available", timeout: 1_200_000 }, async () => {
  checked(compose("up", "-d", "--build", "app"), "start disposable app");
  checked(spawnSync(process.execPath, ["scripts/db-provision.mjs"], { env, encoding: "utf8", timeout: 120000 }), "provision");
  checked(spawnSync(process.execPath, ["scripts/db-migrate.mjs"], { env, encoding: "utf8", timeout: 180000 }), "migrate");
  const postgres = checked(compose("ps", "-q", "postgres"), "find postgres");
  const appContainer = checked(compose("ps", "-q", "app"), "find app");
  const psql = (query) => checked(docker(["exec", "--env", "PGPASSWORD", postgres, "psql", "-h", "127.0.0.1", "-U", "eclipse_bootstrap", "-d", "eclipse", "-v", "ON_ERROR_STOP=1", "-Atc", query],
    { env: { ...env, PGPASSWORD: bootstrap } }), "sql");

  psql(`INSERT INTO owner(id,owner_id,login,password_hash,timezone) VALUES ('${OWNER}','${OWNER}','owner','hash','UTC')`);
  psql(`INSERT INTO sessions(id,owner_id,token_hash,csrf_token,expires_at) VALUES ('${randomUUID()}','${OWNER}','${createHash("sha256").update(TOKEN).digest("hex")}','csrf',now() + interval '1 hour')`);
  const mine = runExport(randomUUID(), 3);
  const theirs = runExport(randomUUID(), 2);
  insertRun(psql, OWNER, mine);
  insertRun(psql, OTHER, theirs);

  // Calls the route from inside the app container, where the app listens, with an optional session cookie.
  const get = (path, { cookie = true, method = "GET" } = {}) => {
    const script = `const r = await fetch("http://127.0.0.1:3000" + process.argv[1], { method: process.argv[2], headers: process.argv[3] ? { cookie: "eclipse_session=" + process.argv[3] } : {} });
      const body = await r.text(); console.log(JSON.stringify({ status: r.status, headers: Object.fromEntries(r.headers), body }));`;
    const result = checked(docker(["exec", appContainer, "node", "--input-type=module", "-e", script, path, method, cookie ? TOKEN : ""]), `GET ${path}`);
    return JSON.parse(result);
  };
  // The app needs a moment to listen.
  for (let i = 0; i < 40; i++) { try { if (get("/api/runs/x/export", { cookie: false }).status) break; } catch { await new Promise((resolve) => setTimeout(resolve, 1500)); } }

  const ok = get(`/api/runs/${mine.run_id}/export`);
  assert.equal(ok.status, 200, ok.body);
  assert.match(ok.headers["content-disposition"], new RegExp(`^attachment; filename="run-${mine.run_id}\\.json"$`));
  assert.match(ok.headers["cache-control"], /no-store/); assert.equal(ok.headers["x-content-type-options"], "nosniff");
  assert.equal(ok.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(ok.body), mine, "the route returns exactly what was stored");

  // Verify on this machine with bare node, then the Docker forms inside the container.
  const verifyHere = spawnSync(process.execPath, ["scripts/eclipse-crew.mjs", "verify", "-", "--key-id", keys.keyId], { input: ok.body, encoding: "utf8" });
  assert.equal(verifyHere.status, 0, verifyHere.stdout + verifyHere.stderr);
  assert.match(verifyHere.stdout, /^PASS  run .* 3 steps  sealed/);
  const verifyInApp = docker(["exec", "-i", appContainer, "node", "scripts/eclipse-crew.mjs", "verify", "-"], { input: ok.body });
  assert.equal(verifyInApp.status, 0, verifyInApp.stdout + verifyInApp.stderr);
  checked(docker(["exec", appContainer, "ln", "-s", "/app/scripts/eclipse-crew.mjs", "/tmp/eclipse-crew"]), "symlink the command");
  const viaLink = docker(["exec", "-i", "-w", "/", appContainer, "node", "/tmp/eclipse-crew", "verify", "-"], { input: ok.body });
  assert.equal(viaLink.status, 0, "works through a symlink from another directory: " + viaLink.stdout + viaLink.stderr);
  const keyIdInApp = checked(docker(["exec", appContainer, "node", "scripts/eclipse-crew.mjs", "key-id"]), "key-id inside the app container");
  assert.equal(keyIdInApp, keys.keyId, "the installed key matches the one in the export");

  // TASK-034 cost receipt and owner-scoped attention.
  psql(`INSERT INTO agents(id,owner_id,name,role,soul_md,status,daily_budget_cents,monthly_budget_cents,attention_reason) VALUES ('${AGENT}','${OWNER}','Ada','Researcher','s','paused',100,1000,'budget_paused')`);
  psql(`INSERT INTO cost_entries(id,owner_id,run_id,agent_id,provider_id,call_index,model,tokens_in,tokens_out,tokens_cached,cost_micro_usd,outcome,idempotency_key) VALUES ('${randomUUID()}','${OWNER}','${mine.run_id}','${AGENT}','${randomUUID()}',1,'muse-spark-1.3',100,10,20,3456,'completed','cost:${mine.run_id}:1')`);
  const cost = get(`/api/runs/${mine.run_id}/cost`);
  assert.equal(cost.status, 200, cost.body);
  const costBody = JSON.parse(cost.body);
  assert.deepEqual(costBody.totals, { calls: 1, inputTokens: 100, outputTokens: 10, cachedInputTokens: 20, costMicroUsd: 3456 });
  assert.equal(costBody.calls[0].model, "muse-spark-1.3"); assert.equal(costBody.currency, "USD");
  assert.equal(get(`/api/runs/${theirs.run_id}/cost`).status, 404, "another owner's cost receipt");
  assert.equal(get(`/api/runs/${randomUUID()}/cost`).status, 404, "unknown cost receipt");
  assert.equal(get(`/api/runs/${mine.run_id}/cost?x=1`).status, 400);
  const attention = get("/api/agents/attention");
  assert.equal(attention.status, 200, attention.body);
  assert.deepEqual(JSON.parse(attention.body).agents.map((agent) => [agent.id, agent.attention]), [[AGENT, "budget_paused"]]);

  // Denied paths.
  assert.equal(get(`/api/runs/${mine.run_id}/export`, { cookie: false }).status, 401);
  assert.equal(get(`/api/runs/${theirs.run_id}/export`).status, 404, "another owner's run");
  assert.equal(get(`/api/runs/${randomUUID()}/export`).status, 404, "unknown run");
  assert.equal(get("/api/runs/not-a-uuid/export").status, 400);
  assert.equal(get(`/api/runs/${mine.run_id}/export?x=1`).status, 400);
  const post = get(`/api/runs/${mine.run_id}/export`, { method: "POST" });
  assert.ok([403, 404, 405].includes(post.status), `POST is refused (got ${post.status})`);

  // A receipt edited in the database is caught by the CLI.
  psql(`UPDATE steps SET receipt_json = replace(receipt_json, 'step 2', 'step X') WHERE run_id = '${mine.run_id}' AND idx = 2`);
  const tampered = get(`/api/runs/${mine.run_id}/export`);
  assert.equal(tampered.status, 200);
  const failed = spawnSync(process.execPath, ["scripts/eclipse-crew.mjs", "verify", "-"], { input: tampered.body, encoding: "utf8" });
  assert.equal(failed.status, 1); assert.match(failed.stdout, /^FAIL  receipt_hash_mismatch  step 2/);
});
