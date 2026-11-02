import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import pg from "pg";
import { clearAgentAttention, setApprovalAttention } from "../lib/costs/store.ts";

const ownerId = randomUUID();
const agentId = randomUUID();

test("approval attention updates use scoped conditional SQL", async () => {
  const dialect = new PgDialect();
  const queries = [];
  const database = { update: () => ({ set: (values) => ({ where: async (condition) => {
    queries.push({ values, ...dialect.sqlToQuery(condition) });
  } }) }) };
  await setApprovalAttention(database, ownerId, agentId);
  await clearAgentAttention(database, ownerId, agentId, "approval_pending");
  assert.equal(queries[0].values.attentionReason, "approval_pending");
  assert.match(queries[0].sql, /"attention_reason" is null.*or.*"attention_reason" =/i);
  assert.deepEqual(queries[0].params, [ownerId, agentId, "approval_pending"]);
  assert.equal(queries[1].values.attentionReason, null);
  assert.match(queries[1].sql, /"attention_reason" =/i);
  assert.deepEqual(queries[1].params, [ownerId, agentId, "approval_pending"]);
});

test("approval waits preserve other reasons in Postgres", async (t) => {
  const docker = (args) => spawnSync("docker", args, { encoding: "utf8", timeout: 120000 });
  if (docker(["version", "--format", "{{.Server.Version}}"]).status !== 0) return t.skip("Docker unavailable");
  const name = `eclipse-attention-${randomBytes(6).toString("hex")}`;
  const password = randomBytes(16).toString("hex");
  const started = docker(["run", "-d", "--name", name, "-e", `POSTGRES_PASSWORD=${password}`, "-p", "127.0.0.1::5432", "postgres:17-alpine"]);
  assert.equal(started.status, 0, started.stderr);
  let pool;
  try {
    for (let i = 0; i < 40; i++) {
      if (docker(["exec", name, "pg_isready", "-U", "postgres", "-h", "127.0.0.1"]).status === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const port = Number(docker(["port", name, "5432/tcp"]).stdout.trim().split(":").pop());
    pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", password, database: "postgres" });
    await pool.query("create table agents (id uuid primary key, owner_id uuid not null, attention_reason text, updated_at timestamptz not null default now())");
    await pool.query("insert into agents(id, owner_id) values ($1, $2)", [agentId, ownerId]);
    const database = drizzle({ client: pool });
    for (const reason of [null, "approval_pending", "budget_warning", "budget_paused", "security_stop"]) {
      await pool.query("update agents set attention_reason = $1 where id = $2", [reason, agentId]);
      await setApprovalAttention(database, ownerId, agentId);
      let result = await pool.query("select attention_reason from agents where id = $1", [agentId]);
      assert.equal(result.rows[0].attention_reason, reason ?? "approval_pending");
      await clearAgentAttention(database, ownerId, agentId, "approval_pending");
      result = await pool.query("select attention_reason from agents where id = $1", [agentId]);
      assert.equal(result.rows[0].attention_reason, reason === null || reason === "approval_pending" ? null : reason);
    }
    await setApprovalAttention(database, randomUUID(), agentId);
    let result = await pool.query("select attention_reason from agents where id = $1", [agentId]);
    assert.equal(result.rows[0].attention_reason, "security_stop");
    await pool.query("update agents set attention_reason = 'approval_pending' where id = $1", [agentId]);
    await clearAgentAttention(database, randomUUID(), agentId, "approval_pending");
    result = await pool.query("select attention_reason from agents where id = $1", [agentId]);
    assert.equal(result.rows[0].attention_reason, "approval_pending");
  } finally {
    await pool?.end();
    const removed = docker(["rm", "-f", name]);
    assert.equal(removed.status, 0, removed.stderr);
  }
});
