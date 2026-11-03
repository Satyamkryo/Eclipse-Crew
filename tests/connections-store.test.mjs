import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const docker = (args) => spawnSync("docker", args, { encoding: "utf8", timeout: 120_000 });
const dockerUp = docker(["version", "--format", "{{.Server.Version}}"]).status === 0;
const name = `eclipse-connections-${randomBytes(6).toString("hex")}`;
const password = randomBytes(16).toString("hex");
const OWNER = randomUUID();
const OTHER = randomUUID();
const AGENT = randomUUID();
const TOKEN = "github_pat_11AAABBBCCCDDDEEEFFF123456789";
let adminPool; let appPool; let database; let service; let data;

test.before(async () => {
  if (!dockerUp) return;
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
  process.env.RECEIPT_SIGNING_KEY = randomBytes(32).toString("hex");
  const started = docker(["run", "-d", "--name", name, "-e", `POSTGRES_PASSWORD=${password}`, "-p", "127.0.0.1::5432",
    "postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b"]);
  assert.equal(started.status, 0, started.stderr);
  for (let i = 0; i < 40; i++) {
    if (docker(["exec", name, "pg_isready", "-U", "postgres", "-h", "127.0.0.1"]).status === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const port = Number(docker(["port", name, "5432/tcp"]).stdout.trim().split(":").pop());
  for (let i = 0; i < 40 && !adminPool; i++) {
    const candidate = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", password, database: "postgres" });
    try { await candidate.query("select 1"); adminPool = candidate; } catch { await candidate.end().catch(() => {}); await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
  assert.ok(adminPool, "database became reachable");
  for (const file of ["0000_solid_risque.sql", "0003_kind_jocasta.sql", "0023_audit_log.sql", "0026_tool_connections.sql", "0030_youthful_talisman.sql"]) {
    const migration = readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8")
      .split("\n").filter((line) => !line.startsWith("--")).join("\n").replaceAll("--> statement-breakpoint", "");
    await adminPool.query(migration);
  }
  await adminPool.query(`CREATE ROLE app_role LOGIN PASSWORD '${password}';
    GRANT SELECT ON public.agents TO app_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.connections TO app_role;
    GRANT SELECT, INSERT ON public.audit_log TO app_role;`);
  await adminPool.query(`INSERT INTO public.owner(id,owner_id,login,password_hash,timezone) VALUES ($1,$1,'owner','hash','UTC')`, [OWNER]);
  await adminPool.query(`INSERT INTO public.owner(id,owner_id,login,password_hash,timezone) VALUES ($1,$1,'other','hash','UTC')`, [OTHER]);
  await adminPool.query(`INSERT INTO public.agents(id,owner_id,name,role,soul_md,status,daily_budget_cents,monthly_budget_cents)
    VALUES ($1,$2,'A','role','soul','active',100,1000)`, [AGENT, OWNER]);
  appPool = new pg.Pool({ host: "127.0.0.1", port, user: "app_role", password, database: "postgres" });
  database = drizzle({ client: appPool });
  service = await import("../lib/connections/service.ts");
  data = await import("../lib/connections/data.ts");
});
test.after(async () => {
  await appPool?.end().catch(() => {}); await adminPool?.end().catch(() => {});
  if (dockerUp) docker(["rm", "-f", name]);
});

const skip = !dockerUp && "Docker is not available";
const input = (label, extra = {}) => ({ agentId: AGENT, preset: "custom", label, token: TOKEN, host: "api.example.com", ...extra });

test("connections are owner-scoped, capped and uniquely labelled", { skip }, async () => {
  const created = await service.createConnection(database, OWNER, input("One"));
  assert.equal(created.tokenHint.endsWith(TOKEN.slice(-4)), true);
  assert.equal(JSON.stringify(created).includes(TOKEN), false);
  assert.equal((await service.listConnectionViews(database, OTHER)).length, 0);
  assert.equal((await service.listConnectionViews(database, OWNER, AGENT)).length, 1);
  await assert.rejects(() => service.createConnection(database, OTHER, input("Two")), (error) => error.code === "not_found");
  await assert.rejects(() => service.createConnection(database, OWNER, input("One")), (error) => error.code === "label_taken");
  for (const label of ["Two", "Three", "Four", "Five", "Six", "Seven", "Eight"]) {
    await service.createConnection(database, OWNER, input(label));
  }
  await assert.rejects(() => service.createConnection(database, OWNER, input("Nine")), (error) => error.code === "connection_limit");
  const rows = await data.listConnections(database, OWNER, AGENT);
  assert.equal(rows.length, 8);
  assert.equal(rows.some((row) => row.bindings.some((binding) => binding.host !== "api.example.com")), false);
});

test("replacing a token rewrites the ciphertext and the audit chain stays clean", { skip }, async () => {
  const [row] = await data.listConnections(database, OWNER, AGENT);
  const before = row.encryptedToken;
  await service.updateConnectionForOwner(database, OWNER, row.id, { token: `${TOKEN}-rotated` });
  const updated = await data.getConnection(database, OWNER, row.id);
  assert.notEqual(updated.encryptedToken, before);
  assert.equal(updated.tokenHint.endsWith("ated"), true);
  const audit = await adminPool.query("select kind, code, entry_json from audit_log where owner_id = $1 order by seq", [OWNER]);
  const kinds = audit.rows.map((entry) => entry.kind);
  assert.equal(kinds.includes("connection_added"), true);
  assert.equal(kinds.includes("connection_replaced"), true);
  assert.equal(audit.rows.some((entry) => entry.entry_json.includes(TOKEN)), false);
  assert.equal(audit.rows.some((entry) => JSON.stringify(entry).includes("api.example.com")), false);
});

test("removing a connection deletes it and logs the removal", { skip }, async () => {
  const rows = await data.listConnections(database, OWNER, AGENT);
  await service.removeConnection(database, OWNER, rows[0].id);
  assert.equal((await data.getConnection(database, OWNER, rows[0].id)), undefined);
  await assert.rejects(() => service.removeConnection(database, OWNER, rows[0].id), (error) => error.code === "not_found");
  const audit = await adminPool.query("select count(*)::int as count from audit_log where owner_id = $1 and kind = 'connection_removed'", [OWNER]);
  assert.equal(audit.rows[0].count, 1);
});

test("deleting the agent cascades its connections", { skip }, async () => {
  assert.ok((await data.listConnections(database, OWNER, AGENT)).length > 0);
  await adminPool.query("DELETE FROM public.agents WHERE id = $1", [AGENT]);
  assert.equal((await data.listConnections(database, OWNER, AGENT)).length, 0);
});
