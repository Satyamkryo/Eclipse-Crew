import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { createRunCostSink, loadRunCostReceipt } from "../lib/costs/store.ts";

const docker = (args, input) => spawnSync("docker", args, { encoding: "utf8", input, timeout: 120000 });
const dockerUp = docker(["version", "--format", "{{.Server.Version}}"]).status === 0;
const name = `eclipse-costs-${randomBytes(6).toString("hex")}`;
const password = randomBytes(16).toString("hex");
const OWNER = randomUUID();
const AGENT = randomUUID();
const PROVIDER = randomUUID();
const RUN = randomUUID();
let adminPool;
let appPool;
let app;

test.before(async () => {
  if (!dockerUp) return;
  const started = docker(["run", "-d", "--name", name, "-e", `POSTGRES_PASSWORD=${password}`, "-p", "127.0.0.1::5432", "postgres:17-alpine"]);
  assert.equal(started.status, 0, started.stderr);
  for (let i = 0; i < 40; i++) {
    if (docker(["exec", name, "pg_isready", "-U", "postgres", "-h", "127.0.0.1"]).status === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const port = Number(docker(["port", name, "5432/tcp"]).stdout.trim().split(":").pop());
  for (let i = 0; i < 40 && !adminPool; i++) {
    const candidate = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", password, database: "postgres" });
    try { await candidate.query("select 1"); adminPool = candidate; }
    catch { await candidate.end().catch(() => {}); await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
  assert.ok(adminPool, "database became reachable");
  await adminPool.query("CREATE ROLE eclipse_app");
  const files = readdirSync(new URL("../drizzle", import.meta.url)).filter((file) => /^\d{4}_.*\.sql$/.test(file)).sort();
  for (const file of files) {
    const migration = readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8").replaceAll("--> statement-breakpoint", "");
    await adminPool.query(migration);
  }
  await adminPool.query(`CREATE ROLE app_role LOGIN PASSWORD '${password}';
    GRANT SELECT, INSERT, UPDATE ON owner TO app_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON agents TO app_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON providers TO app_role;
    GRANT SELECT, INSERT, UPDATE ON model_prices TO app_role;
    GRANT SELECT, INSERT ON cost_entries TO app_role;
    GRANT SELECT, INSERT, UPDATE ON runs TO app_role;`);
  await adminPool.query(`INSERT INTO owner(id,owner_id,login,password_hash,timezone) VALUES ('${OWNER}','${OWNER}','owner','hash','UTC')`);
  await adminPool.query(`INSERT INTO agents(id,owner_id,name,role,soul_md,status,daily_budget_cents,monthly_budget_cents) VALUES ('${AGENT}','${OWNER}','Ada','Researcher','s','active',1,1000)`);
  await adminPool.query(`INSERT INTO providers(id,owner_id,kind) VALUES ('${PROVIDER}','${OWNER}','meta')`);
  await adminPool.query(`INSERT INTO runs(id,owner_id,agent_id,header_json,header_hash,key_id,public_key,started_at) VALUES ('${RUN}','${OWNER}','${AGENT}','{}','${"a".repeat(64)}','k','k',now())`);
  appPool = new pg.Pool({ host: "127.0.0.1", port, user: "app_role", password, database: "postgres" });
  app = drizzle({ client: appPool });
});
test.after(async () => {
  await appPool?.end().catch(() => {});
  await adminPool?.end().catch(() => {});
  if (dockerUp) docker(["rm", "-f", name]);
});

test("the live ledger warns at 80%, pauses and persists attention at 100%, and exposes one receipt", { skip: !dockerUp && "Docker is not available" }, async () => {
  const warnings = [];
  const costs = createRunCostSink({
    database: app, ownerId: OWNER, agentId: AGENT, runId: RUN,
    now: () => new Date(),
    onWarning: (card) => { warnings.push(card); },
  });
  const context = { providerId: PROVIDER, kind: "meta", baseUrl: null, model: "muse-spark-1.3" };
  await costs.beforeCall(context);
  await costs.recordCall({ ...context, usage: { inputTokens: 6_400, outputTokens: 0, cachedInputTokens: 0 }, outcome: "completed" });
  assert.equal(costs.totalMicroUsd(), 8_000);

  await costs.beforeCall(context);
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0], { type: "budget_warning", period: "daily", spentMicroUsd: 8_000, limitCents: 1 });
  await costs.recordCall({ ...context, usage: { inputTokens: 1_600, outputTokens: 0, cachedInputTokens: 0 }, outcome: "completed" });
  assert.equal(costs.totalMicroUsd(), 10_000);

  await assert.rejects(costs.beforeCall(context), (error) => error.code === "budget_paused" && error.card.type === "budget_paused");
  const agent = await adminPool.query("select status, attention_reason from agents where id=$1", [AGENT]);
  assert.deepEqual(agent.rows[0], { status: "paused", attention_reason: "budget_paused" });
  const duplicate = await adminPool.query(`INSERT INTO cost_entries(id,owner_id,run_id,agent_id,provider_id,call_index,model,tokens_in,tokens_out,tokens_cached,cost_micro_usd,outcome,idempotency_key) VALUES ('${randomUUID()}','${OWNER}','${RUN}','${AGENT}','${PROVIDER}',1,'muse-spark-1.3',1,0,0,1,'completed','cost:${RUN}:1')`).catch((error) => error);
  assert.match(String(duplicate), /duplicate key|unique/i);

  const receipt = await loadRunCostReceipt(app, OWNER, RUN);
  assert.deepEqual(receipt.totals, { calls: 2, inputTokens: 8_000, outputTokens: 0, cachedInputTokens: 0, costMicroUsd: 10_000 });
  assert.deepEqual(receipt.calls.map((call) => [call.callIndex, call.costMicroUsd, call.outcome]), [[1, 8_000, "completed"], [2, 2_000, "completed"]]);
  assert.equal(await loadRunCostReceipt(app, randomUUID(), RUN), null);
});

test("a price edit affects only later calls in the append-only ledger", { skip: !dockerUp && "Docker is not available" }, async () => {
  const agent = randomUUID(); const run = randomUUID();
  await adminPool.query(`INSERT INTO agents(id,owner_id,name,role,soul_md,status,daily_budget_cents,monthly_budget_cents) VALUES ('${agent}','${OWNER}','Cy','Researcher','s','active',100000000,100000000)`);
  await adminPool.query(`INSERT INTO runs(id,owner_id,agent_id,header_json,header_hash,key_id,public_key,started_at) VALUES ('${run}','${OWNER}','${agent}','{}','${"a".repeat(64)}','k','k',now())`);
  const costs = createRunCostSink({ database: app, ownerId: OWNER, agentId: agent, runId: run });
  const context = { providerId: PROVIDER, kind: "meta", baseUrl: null, model: "muse-wonder-1.0" };
  await costs.beforeCall(context);
  await costs.recordCall({ ...context, usage: { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0 }, outcome: "completed" });
  await adminPool.query(`INSERT INTO model_prices(id,owner_id,provider_id,model,input_micro_usd_per_million,cached_micro_usd_per_million,output_micro_usd_per_million,image_micro_usd_per_thousand) VALUES ('${randomUUID()}','${OWNER}','${PROVIDER}','muse-wonder-1.0',2000000,0,0,0)`);
  await costs.beforeCall(context);
  await costs.recordCall({ ...context, usage: { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0 }, outcome: "completed" });
  const receipt = await loadRunCostReceipt(app, OWNER, run);
  assert.deepEqual(receipt.calls.map((call) => call.costMicroUsd), [4_000_000, 2_000_000]);
  assert.equal(receipt.totals.costMicroUsd, 6_000_000);
});

test("two runs can each make at most the one call they checked before the shared total pauses", { skip: !dockerUp && "Docker is not available" }, async () => {
  const agent = randomUUID(); const firstRun = randomUUID(); const secondRun = randomUUID();
  await adminPool.query(`INSERT INTO agents(id,owner_id,name,role,soul_md,status,daily_budget_cents,monthly_budget_cents) VALUES ('${agent}','${OWNER}','Bo','Researcher','s','active',1,1000)`);
  for (const run of [firstRun, secondRun]) {
    await adminPool.query(`INSERT INTO runs(id,owner_id,agent_id,header_json,header_hash,key_id,public_key,started_at) VALUES ('${run}','${OWNER}','${agent}','{}','${"a".repeat(64)}','k','k',now())`);
  }
  const context = { providerId: PROVIDER, kind: "meta", baseUrl: null, model: "muse-spark-1.3" };
  const first = createRunCostSink({ database: app, ownerId: OWNER, agentId: agent, runId: firstRun });
  const second = createRunCostSink({ database: app, ownerId: OWNER, agentId: agent, runId: secondRun });
  await first.beforeCall(context);
  await second.beforeCall(context);
  await first.recordCall({ ...context, usage: { inputTokens: 6_400, outputTokens: 0, cachedInputTokens: 0 }, outcome: "completed" });
  await second.recordCall({ ...context, usage: { inputTokens: 6_400, outputTokens: 0, cachedInputTokens: 0 }, outcome: "completed" });
  const total = await adminPool.query("select sum(cost_micro_usd)::int as total from cost_entries where agent_id=$1", [agent]);
  assert.equal(total.rows[0].total, 16_000);
  await assert.rejects(first.beforeCall(context), (error) => error.code === "budget_paused");
});
