import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { verifyAuditExport } from "../lib/security/audit-chain.mjs";

const docker = (args, input) => spawnSync("docker", args, { encoding: "utf8", input, timeout: 120000 });
const dockerUp = docker(["version", "--format", "{{.Server.Version}}"]).status === 0;
const name = `eclipse-audit-${randomBytes(6).toString("hex")}`;
const password = randomBytes(16).toString("hex");
const SEED = randomBytes(32).toString("hex");
const OWNER = randomUUID();
const OTHER_OWNER = randomUUID();
let adminPool; let appPool; let app; let store;

test.before(async () => {
  if (!dockerUp) return;
  process.env.RECEIPT_SIGNING_KEY = SEED;
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
  for (const file of ["0000_solid_risque.sql", "0023_audit_log.sql"]) {
    const migration = readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8").replaceAll("--> statement-breakpoint", "");
    await adminPool.query(migration);
  }
  await adminPool.query(`CREATE ROLE app_role LOGIN PASSWORD '${password}'; GRANT SELECT, INSERT ON audit_log TO app_role;`);
  appPool = new pg.Pool({ host: "127.0.0.1", port, user: "app_role", password, database: "postgres" });
  app = drizzle({ client: appPool });
  store = await import("../lib/security/audit.ts");
});
test.after(async () => {
  await appPool?.end().catch(() => {}); await adminPool?.end().catch(() => {});
  if (dockerUp) docker(["rm", "-f", name]);
});

const skip = !dockerUp && "Docker is not available";
const write = (ownerId, input) => app.transaction((transaction) => store.recordAudit(transaction, ownerId, input));

test("20 concurrent writers get one gap-free signed chain", { skip }, async () => {
  await Promise.all(Array.from({ length: 20 }, () => write(OWNER, { kind: "login" })));
  const rows = await adminPool.query("select seq from audit_log where owner_id = $1 order by seq", [OWNER]);
  assert.deepEqual(rows.rows.map((row) => Number(row.seq)), Array.from({ length: 20 }, (_, index) => index + 1));
  const exported = await store.loadAuditExport(app, OWNER);
  const result = verifyAuditExport(exported);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.entries, 20);
  const status = await store.auditStatus(app, OWNER);
  assert.deepEqual([status.signing, status.verified, status.entries], [true, true, 20]);
});

test("a duplicate source reference is recorded once", { skip }, async () => {
  const first = await write(OWNER, { kind: "egress_blocked", host: "evil.test", sourceRef: "boot:1" });
  const second = await write(OWNER, { kind: "egress_blocked", host: "evil.test", sourceRef: "boot:1" });
  assert.equal(first, true);
  assert.equal(second, false);
});

test("the runtime role cannot rewrite or delete the audit log", { skip }, async () => {
  await assert.rejects(() => appPool.query("update audit_log set kind = 'login'"));
  await assert.rejects(() => appPool.query("delete from audit_log"));
});

test("tampering with a stored entry fails offline verification", { skip }, async () => {
  await adminPool.query("update audit_log set entry_json = replace(entry_json, '\"login\"', '\"login\" ') where owner_id = $1 and seq = 1", [OWNER]);
  const exported = await store.loadAuditExport(app, OWNER);
  const result = verifyAuditExport(exported);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "entry_hash_mismatch");
  await adminPool.query("update audit_log set entry_json = replace(entry_json, '\"login\" ', '\"login\"') where owner_id = $1 and seq = 1", [OWNER]);
});

test("one owner's chain never verifies as another owner's", { skip }, async () => {
  await write(OTHER_OWNER, { kind: "login" });
  const exported = await store.loadAuditExport(app, OTHER_OWNER);
  const forged = { ...exported, owner_id: OWNER };
  assert.equal(verifyAuditExport(forged).ok, false);
});
