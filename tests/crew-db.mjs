import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

export const dockerUp = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8", timeout: 30000 }).status === 0;

// One throwaway Postgres for the crew suites. The image is pinned like the Compose service, and the app role exists before
// migration 0019, which grants it the queue schema.
export async function createCrewDatabase() {
  if (!dockerUp) return { skip: "Docker is not available" };
  const name = `eclipse-crew-${randomBytes(6).toString("hex")}`;
  const password = randomBytes(16).toString("hex");
  const started = spawnSync("docker", ["run", "-d", "--name", name, "-e", `POSTGRES_PASSWORD=${password}`, "-p", "127.0.0.1::5432",
    "postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b"], { encoding: "utf8", timeout: 120000 });
  if (started.status !== 0) throw new Error(started.stderr || "could not start test Postgres");
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (spawnSync("docker", ["exec", name, "pg_isready", "-U", "postgres", "-h", "127.0.0.1"]).status === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const port = Number(spawnSync("docker", ["port", name, "5432/tcp"], { encoding: "utf8" }).stdout.trim().split(":").pop());
    let adminPool;
    for (let attempt = 0; attempt < 40 && !adminPool; attempt++) {
      const candidate = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", password, database: "postgres" });
      try { await candidate.query("select 1"); adminPool = candidate; }
      catch { await candidate.end().catch(() => {}); await new Promise((resolve) => setTimeout(resolve, 500)); }
    }
    if (!adminPool) throw new Error("test database did not become reachable");
    await adminPool.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC; CREATE ROLE eclipse_app LOGIN PASSWORD '${password}';`);
    const files = readdirSync(new URL("../drizzle", import.meta.url)).filter((file) => /^\d{4}_.*\.sql$/.test(file)).sort();
    for (const file of files) {
      await adminPool.query(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""));
    }
    await adminPool.query(`CREATE SCHEMA IF NOT EXISTS drizzle; GRANT USAGE ON SCHEMA public TO eclipse_app;
      GRANT SELECT, INSERT, UPDATE ON owner, agents, agent_policies, audit_log, sessions, model_roles, providers, routines, chat_sessions, messages, starter_crew_setups, starter_crew_members, crew_report_settings, crew_report_deliveries TO eclipse_app;
      GRANT SELECT, INSERT ON chat_sessions, messages, runs, steps, run_meta, cost_entries, audit_log TO eclipse_app;
      GRANT SELECT ON runs, steps, run_meta, cost_entries, approvals, teach_recordings TO eclipse_app;
      GRANT INSERT ON crew_report_deliveries TO eclipse_app;
      GRANT USAGE ON SCHEMA pgboss TO eclipse_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO eclipse_app;
      GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA pgboss TO eclipse_app;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO eclipse_app;`);
    const pool = new pg.Pool({ host: "127.0.0.1", port, user: "eclipse_app", password, database: "postgres", max: 4 });
    const app = drizzle({ client: pool });
    process.env.DATABASE_URL = `postgresql://eclipse_app:${password}@127.0.0.1:${port}/postgres`;
    process.env.APP_ORIGIN = "http://127.0.0.1:3000";
    return { skip: false, app, pool, adminPool, name };
  } catch (error) {
    spawnSync("docker", ["rm", "-f", name], { timeout: 30000 });
    throw error;
  }
}

export async function cleanupCrewDatabase(handle) {
  if (!handle || handle.skip) return;
  try {
    const { stopRoutineQueue } = await import("../lib/routines/queue.ts");
    await stopRoutineQueue();
  } catch { /* the queue was never started */ }
  await handle.pool?.end().catch(() => {});
  await handle.adminPool?.end().catch(() => {});
  spawnSync("docker", ["rm", "-f", handle.name], { timeout: 30000 });
}

export async function insertOwner(adminPool, id = randomUUID(), timezone = "Asia/Kolkata") {
  await adminPool.query(`INSERT INTO owner(id, owner_id, login, password_hash, timezone) VALUES ($1,$1,$2,'hash',$3)`,
    [id, `owner-${id}`, timezone]);
  return id;
}

export async function insertAgent(adminPool, ownerId, { id = randomUUID(), name = "Briefer", status = "active", attention = null } = {}) {
  await adminPool.query(`INSERT INTO agents(id, owner_id, name, role, soul_md, status, daily_budget_cents, monthly_budget_cents, attention_reason)
    VALUES ($1,$2,$3,'Role','Be careful.',$4,10000,100000,$5)`, [id, ownerId, name, status, attention]);
  return id;
}

export function password() { return randomBytes(8).toString("hex"); }
