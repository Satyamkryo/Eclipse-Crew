import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

// TASK-050 against a real Postgres: one decision per request, grants scoped to one agent + exact host + class,
// revoke, use counting and the runtime grants.
const docker = (args) => spawnSync("docker", args, { encoding: "utf8", timeout: 120000 });
const dockerUp = docker(["version", "--format", "{{.Server.Version}}"]).status === 0;
const name = `eclipse-approvals-${randomBytes(6).toString("hex")}`;
const password = randomBytes(16).toString("hex");
const OWNER = randomUUID();
const AGENT_A = randomUUID();
const AGENT_B = randomUUID();
let admin;
let appPool;
let app;
let store;
let gateModule;
let port;

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
  await admin.query(`CREATE ROLE eclipse_app LOGIN PASSWORD '${password}'; REVOKE CREATE ON SCHEMA public FROM PUBLIC;`);
  const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) {
    await admin.query(readFileSync(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  await admin.query(`CREATE SCHEMA drizzle;
    REVOKE ALL ON SCHEMA drizzle FROM PUBLIC, eclipse_app; REVOKE CREATE, TEMP ON DATABASE postgres FROM PUBLIC, eclipse_app;
    GRANT USAGE ON SCHEMA public TO eclipse_app;
    GRANT SELECT, INSERT, UPDATE ON approvals, permissions TO eclipse_app;
    GRANT SELECT, INSERT ON permission_uses TO eclipse_app;`);
  await admin.query("INSERT INTO owner(id, owner_id, login, password_hash, timezone) VALUES($1, $1, 'owner', 'hash', 'UTC')", [OWNER]);
  for (const id of [AGENT_A, AGENT_B]) {
    await admin.query("INSERT INTO agents(id, owner_id, name, role, soul_md, status, daily_budget_cents, monthly_budget_cents) VALUES($1, $2, 'Ada', 'Tester', 'soul', 'active', 100, 1000)", [id, OWNER]);
  }
  appPool = new pg.Pool({ connectionString: `postgresql://eclipse_app:${password}@127.0.0.1:${port}/postgres` });
  appPool.on("error", () => {});
  app = drizzle({ client: appPool });
  store = unwrap(await import("../lib/approvals/store.ts"));
  gateModule = unwrap(await import("../lib/approvals/gate.ts"));
});

test.after(async () => {
  await appPool?.end().catch(() => undefined);
  await admin?.end().catch(() => undefined);
  if (dockerUp) docker(["rm", "-f", name]);
});

const skip = !dockerUp;
const pending = (agentId = AGENT_A, site = "example.com", actionClass = "download") =>
  store.createApproval(app, { ownerId: OWNER, agentId, runId: randomUUID(), actionClass, site, controlName: "Download PDF" });

test("a request is decided once and a deny cannot later become an allow", { skip }, async () => {
  const id = await pending();
  const results = await Promise.all([store.decideApproval(app, OWNER, id, "allow_once"), store.decideApproval(app, OWNER, id, "deny")]);
  assert.equal(results.filter((result) => result.ok).length, 1, "exactly one decision wins");
  const winner = results.find((result) => result.ok);
  assert.ok(winner.ok);
  const final = await store.getApproval(app, OWNER, id);
  assert.equal(final.state, winner.approval.state);
  assert.deepEqual(await store.decideApproval(app, OWNER, id, "always_allow"), { ok: false, error: "already_decided" });
});

test("an expired request is never allowed", { skip }, async () => {
  const id = await pending();
  assert.equal(await store.expireApproval(app, OWNER, id), true);
  assert.deepEqual(await store.decideApproval(app, OWNER, id, "allow_once"), { ok: false, error: "expired" });
});

test("Always allow stores one grant for exactly this agent, host and class; revoke takes effect at once", { skip }, async () => {
  const id = await pending(AGENT_A, "example.com", "download");
  const decided = await store.decideApproval(app, OWNER, id, "always_allow");
  assert.equal(decided.ok, true);
  const grant = await store.findGrant(app, OWNER, AGENT_A, "example.com", "download");
  assert.ok(grant);
  assert.equal(grant.maxPerDay, 20);
  assert.equal(await store.findGrant(app, OWNER, AGENT_A, "app.example.com", "download"), null, "subdomains do not match");
  assert.equal(await store.findGrant(app, OWNER, AGENT_A, "example.com", "delete"), null, "other classes do not match");
  assert.equal(await store.findGrant(app, OWNER, AGENT_B, "example.com", "download"), null, "other agents do not match");

  assert.equal(await store.revokeGrant(app, OWNER, grant.id), true);
  assert.equal(await store.findGrant(app, OWNER, AGENT_A, "example.com", "download"), null);
  assert.deepEqual(await store.listGrants(app, OWNER, AGENT_A), []);
  const replacement = await store.createGrant(app, { ownerId: OWNER, agentId: AGENT_A, site: "example.com", actionClass: "download" });
  assert.notEqual(replacement, grant.id, "a new grant may follow a revoke");
});

test("uses are counted inside the rolling window and the owner can see every active grant", { skip }, async () => {
  const id = await store.createGrant(app, { ownerId: OWNER, agentId: AGENT_B, site: "vendor.example", actionClass: "send", maxPerDay: 2 });
  await store.recordUse(app, OWNER, id, randomUUID());
  await store.recordUse(app, OWNER, id, randomUUID());
  assert.equal(await store.countUses(app, OWNER, id, new Date(Date.now() - 24 * 60 * 60_000)), 2);
  const listed = await store.listGrants(app, OWNER, AGENT_B);
  assert.deepEqual(listed.map((row) => [row.site, row.actionClass, row.maxPerDay]), [["vendor.example", "send", 2]]);
});

test("a grant over its daily limit asks the owner again instead of acting", { skip }, async () => {
  await store.createGrant(app, { ownerId: OWNER, agentId: AGENT_B, site: "limit.example", actionClass: "download", maxPerDay: 1 });
  const cards = [];
  const gate = gateModule.createApprovalGate({
    database: app, ownerId: OWNER, postCard: async (card) => { cards.push(card); }, waitMs: 20,
  });
  const request = { agentId: AGENT_B, runId: randomUUID(), actionClass: "download", site: "limit.example", controlName: "Download PDF" };
  assert.equal((await gate.request(request)).reason, "grant");
  const second = await gate.request(request);
  assert.equal(second.decision, "deny");
  assert.equal(second.reason, "timeout");
  assert.equal(cards.length, 1, "the owner is asked again");
  assert.equal(cards[0].type, "approval");
  const row = await admin.query("SELECT state FROM approvals WHERE id = $1", [second.approvalId]);
  assert.equal(row.rows[0].state, "expired", "an unanswered request expires");
});

test("the runtime role can decide but cannot delete approval history", { skip }, async () => {
  const id = await pending(AGENT_A, "counter.example", "post");
  assert.equal(await store.decideApproval(app, OWNER, id, "deny").then((result) => result.ok), true);
  const runtime = new pg.Pool({ connectionString: `postgresql://eclipse_app:${password}@127.0.0.1:${port}/postgres` });
  try {
    await assert.rejects(() => runtime.query("DELETE FROM approvals"), /permission denied/);
    await assert.rejects(() => runtime.query("DELETE FROM permission_uses"), /permission denied/);
  } finally {
    await runtime.end();
  }
});
