import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { verifyRunExport } from "../lib/receipts/chain.mjs";
import { loadReceiptSigner } from "../lib/receipts/signer.ts";
import { createReceiptRecorder, loadRunExport } from "../lib/receipts/store.ts";

// A throwaway Postgres container with only the 0009 tables and the same grants the app role gets in production.
const docker = (args, input) => spawnSync("docker", args, { encoding: "utf8", input, timeout: 120000 });
const dockerUp = docker(["version", "--format", "{{.Server.Version}}"]).status === 0;
const name = `eclipse-receipts-${randomBytes(6).toString("hex")}`;
const password = randomBytes(16).toString("hex");
const OWNER = randomUUID();
const OTHER_OWNER = randomUUID();
const AGENT = randomUUID();
const SEED = randomBytes(32).toString("hex");
let adminPool; let appPool; let app;

test.before(async () => {
  if (!dockerUp) return;
  const started = docker(["run", "-d", "--name", name, "-e", `POSTGRES_PASSWORD=${password}`, "-p", "127.0.0.1::5432",
    "postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b"]);
  assert.equal(started.status, 0, started.stderr);
  for (let i = 0; i < 40; i++) {
    if (docker(["exec", name, "pg_isready", "-U", "postgres", "-h", "127.0.0.1"]).status === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const port = Number(docker(["port", name, "5432/tcp"]).stdout.trim().split(":").pop());
  // The image restarts once during init; wait for a real connection.
  for (let i = 0; i < 40 && !adminPool; i++) {
    const candidate = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", password, database: "postgres" });
    try { await candidate.query("select 1"); adminPool = candidate; } catch { await candidate.end().catch(() => {}); await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
  assert.ok(adminPool, "database became reachable");
  const migration = readFileSync(new URL("../drizzle/0009_receipts_runs_steps.sql", import.meta.url), "utf8").replaceAll("--> statement-breakpoint", "");
  await adminPool.query(migration);
  await adminPool.query(`CREATE ROLE app_role LOGIN PASSWORD '${password}'; GRANT SELECT, INSERT, UPDATE ON runs TO app_role; GRANT SELECT, INSERT ON steps TO app_role;`);
  appPool = new pg.Pool({ host: "127.0.0.1", port, user: "app_role", password, database: "postgres" });
  app = drizzle({ client: appPool });
});
test.after(async () => {
  await appPool?.end().catch(() => {}); await adminPool?.end().catch(() => {});
  if (dockerUp) docker(["rm", "-f", name]);
});

const stepInput = (idx) => ({ idx, model: "m", model_label: "m", route: "main", action: { kind: "wait" }, target: null, grounding_method: null, methods: [],
  sam: "off", confidence: "medium", before_hash: null, after_hash: null, postcondition: `expect ${idx}`, result: "pass", code: null, executed: true,
  usage: { input: 1, output: 1, cached: 0, reasoning: 0 }, cost_micro_usd: null });

async function recordedRun(steps = 3, owner = OWNER) {
  const recorder = createReceiptRecorder({ database: app, ownerId: owner, agentId: AGENT, agentName: "Ada", task: "Open the settings page.", signer: loadReceiptSigner(SEED) });
  await recorder.begin();
  for (let idx = 1; idx <= steps; idx++) await recorder.step(stepInput(idx));
  await recorder.seal("finished", { input: steps, output: steps, cached: 0, reasoning: 0 });
  return recorder.runId;
}

test("the recorder writes a chain to Postgres that exports and verifies", { skip: !dockerUp && "Docker is not available" }, async () => {
  const runId = await recordedRun(3);
  const exported = await loadRunExport(app, OWNER, runId);
  const result = verifyRunExport(exported, { pinnedKeyId: loadReceiptSigner(SEED).keyId });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual([result.steps, exported.seal.status, exported.seal.step_count], [3, "finished", 3]);
  assert.deepEqual(exported.steps.map((s) => s.idx), [1, 2, 3]);
  const stored = await adminPool.query("select status, signature is not null as sealed, ended_at is not null as ended from runs where id = $1", [runId]);
  assert.deepEqual(stored.rows[0], { status: "finished", sealed: true, ended: true });
});

test("the store rejects out-of-order steps, a second seal and a step after sealing", { skip: !dockerUp && "Docker is not available" }, async () => {
  const recorder = createReceiptRecorder({ database: app, ownerId: OWNER, agentId: AGENT, agentName: "Ada", task: "t", signer: loadReceiptSigner(SEED) });
  await assert.rejects(() => recorder.step(stepInput(1)), /not open/, "no step before the run starts");
  await recorder.begin();
  await assert.rejects(() => recorder.begin(), /already started/);
  await assert.rejects(() => recorder.step(stepInput(2)), /out of order/);
  await recorder.step(stepInput(1));
  await recorder.seal("finished", { input: 0, output: 0, cached: 0, reasoning: 0 });
  await assert.rejects(() => recorder.seal("finished", { input: 0, output: 0, cached: 0, reasoning: 0 }), /not open/);
  await assert.rejects(() => recorder.step(stepInput(2)), /not open/);
  assert.equal((await adminPool.query("select count(*)::int as n from steps where run_id = $1", [recorder.runId])).rows[0].n, 1);
});

test("proof cannot be rewritten through the app role, and edits made as an admin are caught", { skip: !dockerUp && "Docker is not available" }, async () => {
  const runId = await recordedRun(3);
  await assert.rejects(() => appPool.query("update steps set receipt_json = '{}' where run_id = $1", [runId]), /permission denied/);
  await assert.rejects(() => appPool.query("delete from steps where run_id = $1", [runId]), /permission denied/);
  await assert.rejects(() => appPool.query("delete from runs where id = $1", [runId]), /permission denied/);
  await assert.rejects(() => appPool.query("update runs set signature = null where id = $1", [runId]), /check/, "a half-cleared seal is refused");
  const second = await appPool.query("update runs set status = 'x' where id = $1 and signature is null", [runId]);
  assert.equal(second.rowCount, 0, "a sealed run matches no further seal");

  // Someone with database access rewrites a receipt: the export no longer verifies.
  await adminPool.query("update steps set receipt_json = replace(receipt_json, 'expect 2', 'expect X') where run_id = $1 and idx = 2", [runId]);
  const tampered = verifyRunExport(await loadRunExport(app, OWNER, runId));
  assert.deepEqual([tampered.ok, tampered.reason, tampered.step], [false, "receipt_hash_mismatch", 2]);

  // The app role needs UPDATE on runs to seal, so it could overwrite a seal. That is detected, not blocked: without the key the
  // signature no longer verifies.
  const rewritten = await recordedRun(2);
  await appPool.query("update runs set status = 'finished_ok' where id = $1", [rewritten]);
  assert.equal(verifyRunExport(await loadRunExport(app, OWNER, rewritten)).reason, "bad_signature");

  const other = await recordedRun(3);
  await adminPool.query("delete from steps where run_id = $1 and idx = 3", [other]);
  assert.equal(verifyRunExport(await loadRunExport(app, OWNER, other)).reason, "step_count_mismatch");
});

test("exports are scoped to their owner", { skip: !dockerUp && "Docker is not available" }, async () => {
  const runId = await recordedRun(1);
  assert.notEqual(await loadRunExport(app, OWNER, runId), null);
  assert.equal(await loadRunExport(app, OTHER_OWNER, runId), null, "another owner sees nothing");
  assert.equal(await loadRunExport(app, OWNER, randomUUID()), null, "unknown run");
});

test("a run that never sealed exports with no seal and fails verification", { skip: !dockerUp && "Docker is not available" }, async () => {
  const recorder = createReceiptRecorder({ database: app, ownerId: OWNER, agentId: AGENT, agentName: "Ada", task: "t", signer: loadReceiptSigner(SEED) });
  await recorder.begin(); await recorder.step(stepInput(1));
  const exported = await loadRunExport(app, OWNER, recorder.runId);
  assert.equal(exported.seal, null);
  assert.equal(verifyRunExport(exported).reason, "unsealed");
});
