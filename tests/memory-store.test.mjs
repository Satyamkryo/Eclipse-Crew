import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const docker = (args, input) => spawnSync("docker", args, { encoding: "utf8", input, timeout: 120000 });
const dockerUp = docker(["version", "--format", "{{.Server.Version}}"]).status === 0;
const name = `eclipse-memory-${randomBytes(6).toString("hex")}`;
const password = randomBytes(16).toString("hex");
const OWNER = randomUUID();
const AGENT_A = randomUUID();
const AGENT_B = randomUUID();
let adminPool; let appPool; let app; let store; let snapshot; let mirror;
let mirrorDir;

const skip = !dockerUp && "Docker is not available";

test.before(async () => {
  if (!dockerUp) return;
  mirrorDir = await mkdtemp(path.join(tmpdir(), "eclipse-memory-"));
  process.env.MEMORY_MIRROR_DIR = mirrorDir;
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
  for (const file of ["0000_solid_risque.sql", "0003_kind_jocasta.sql", "0024_memory_storage.sql"]) {
    const migration = readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8").replaceAll("--> statement-breakpoint", "");
    await adminPool.query(migration);
  }
  await adminPool.query(`CREATE ROLE app_role LOGIN PASSWORD '${password}';
    GRANT SELECT, INSERT, UPDATE ON memory_entries TO app_role;
    GRANT SELECT, INSERT ON memory_versions TO app_role;
    GRANT SELECT, UPDATE ON agents TO app_role;
    GRANT SELECT ON agent_policies TO app_role;`);
  await adminPool.query("INSERT INTO owner(id,owner_id,login,password_hash,timezone) VALUES ($1,$1,'owner','hash','UTC')", [OWNER]);
  for (const agentId of [AGENT_A, AGENT_B]) {
    await adminPool.query("INSERT INTO agents(id,owner_id,name,role,soul_md,status,daily_budget_cents,monthly_budget_cents) VALUES ($1,$2,'Ada','Researcher','Be careful.','active',100,1000)", [agentId, OWNER]);
    await adminPool.query("INSERT INTO agent_policies(agent_id,owner_id,tools,domains,actions,memory_scopes) VALUES ($1,$2,'{}','{}','{}','{global,agent,private}')", [agentId, OWNER]);
  }
  appPool = new pg.Pool({ host: "127.0.0.1", port, user: "app_role", password, database: "postgres" });
  app = drizzle({ client: appPool });
  store = await import("../lib/memory/store.ts");
  snapshot = await import("../lib/memory/snapshot.ts");
  mirror = await import("../lib/memory/mirror.ts");
});
test.after(async () => {
  await appPool?.end().catch(() => {}); await adminPool?.end().catch(() => {});
  if (dockerUp) docker(["rm", "-f", name]);
});

test("TASK-053: adds, edits, pins, removes and versions each document", { skip }, async () => {
  const added = await store.applyMemoryChange(app, OWNER, {
    op: "add", doc: "memory", agentId: AGENT_A, title: "Vendor portal", body: "Use the Northstar page.", author: "owner",
  });
  assert.equal(added.ok, true);
  const edited = await store.applyMemoryChange(app, OWNER, {
    op: "edit", entryId: added.entry.id, title: "Vendor portal", body: "Use the Northstar page and verify each file.", author: "owner",
  });
  assert.equal(edited.ok, true);
  const pinned = await store.applyMemoryChange(app, OWNER, { op: "pin", entryId: added.entry.id, author: "owner" });
  assert.equal(pinned.ok, true);
  const history = await store.listHistory(app, OWNER, `agent:${AGENT_A}:memory`);
  assert.deepEqual(history.map((version) => version.op), ["pin", "edit", "add"]);
  assert.deepEqual(history.map((version) => version.seq), [3, 2, 1]);
  const removed = await store.applyMemoryChange(app, OWNER, { op: "remove", entryId: added.entry.id, author: "owner" });
  assert.equal(removed.ok, true);
  const view = await store.listMemory(app, OWNER, AGENT_A);
  assert.equal(view.memory.entries.length, 0);
  assert.equal(view.memory.chars, 0);
});

test("TASK-053: a scope-less or duplicate write is refused, and the cap holds", { skip }, async () => {
  const first = await store.applyMemoryChange(app, OWNER, {
    op: "add", doc: "user", agentId: null, title: "Timezone", body: "The owner is in IST.", author: "owner",
  });
  assert.equal(first.ok, true);
  const duplicate = await store.applyMemoryChange(app, OWNER, {
    op: "add", doc: "user", agentId: null, title: "timezone", body: "Again.", author: "owner",
  });
  assert.deepEqual([duplicate.ok, duplicate.error], [false, "duplicate_title"]);
  for (let index = 1; index <= 2; index++) {
    const filler = await store.applyMemoryChange(app, OWNER, {
      op: "add", doc: "user", agentId: null, title: `Filler ${index}`, body: "x".repeat(600), author: "owner",
    });
    assert.equal(filler.ok, true);
  }
  const tooBig = await store.applyMemoryChange(app, OWNER, {
    op: "add", doc: "user", agentId: null, title: "Big", body: "x".repeat(600), author: "owner",
  });
  assert.deepEqual([tooBig.ok, tooBig.error], [false, "over_cap"]);
  const badVisible = await store.applyMemoryChange(app, OWNER, {
    op: "add", doc: "private", agentId: AGENT_A, title: "Secret", body: "Only A.", visibleTo: [randomUUID()], author: "owner",
  });
  assert.deepEqual([badVisible.ok, badVisible.error], [false, "invalid_visible_to"]);
});

test("TASK-053: concurrent writes get distinct, gap-free versions", { skip }, async () => {
  const writes = Array.from({ length: 10 }, (_, index) => store.applyMemoryChange(app, OWNER, {
    op: "add", doc: "private", agentId: AGENT_B, title: `Note ${index}`, body: `Body ${index}`, author: "owner",
  }));
  const results = await Promise.all(writes);
  assert.ok(results.every((result) => result.ok));
  const history = await store.listHistory(app, OWNER, `agent:${AGENT_B}:private`);
  assert.deepEqual(history.map((version) => version.seq).sort((a, b) => a - b), Array.from({ length: 10 }, (_, index) => index + 1));
});

test("TASK-053: the snapshot is frozen per run and private notes stay scoped", { skip }, async () => {
  const first = await snapshot.loadMemorySnapshot(app, OWNER, AGENT_A);
  const before = first.text;
  await store.applyMemoryChange(app, OWNER, {
    op: "add", doc: "memory", agentId: AGENT_A, title: "New fact", body: "Visible next run only.", author: "owner",
  });
  assert.equal(first.text, before, "the already-loaded snapshot does not change");
  const second = await snapshot.loadMemorySnapshot(app, OWNER, AGENT_A);
  assert.match(second.text, /New fact/);
  const other = await snapshot.loadMemorySnapshot(app, OWNER, AGENT_B);
  assert.doesNotMatch(other.text, /New fact/, "agent B never reads agent A's MEMORY.md");
  assert.match(other.text, /Timezone/, "USER.md is shared when the policy allows global");
});

test("TASK-053: a shared private note appears in the listed reader's snapshot", { skip }, async () => {
  const shared = await store.applyMemoryChange(app, OWNER, {
    op: "add", doc: "private", agentId: AGENT_A, title: "Shared handoff", body: "Visible to agent B.",
    visibleTo: [AGENT_B], author: "owner",
  });
  assert.equal(shared.ok, true);
  const second = await snapshot.loadMemorySnapshot(app, OWNER, AGENT_B);
  assert.match(second.text, /Shared handoff: Visible to agent B\./);
});

test("TASK-053: SOUL.md edits are versioned and the Markdown mirror matches the database", { skip }, async () => {
  const soul = await store.updateSoul(app, OWNER, AGENT_A, "You are Ada. Be careful and brief.");
  assert.equal(soul.ok, true);
  const history = await store.listHistory(app, OWNER, `agent:${AGENT_A}:soul`);
  assert.equal(history[0].op, "soul_edit");
  const status = await mirror.scheduleMirror(app, OWNER, AGENT_A);
  assert.equal(status.ok, true);
  const userFile = await readFile(path.join(mirrorDir, "USER.md"), "utf8");
  assert.match(userFile, /Edits to this file are not read back/);
  assert.match(userFile, /Timezone/);
  const memoryFile = await readFile(path.join(mirrorDir, "agents", AGENT_A, "MEMORY.md"), "utf8");
  assert.match(memoryFile, /New fact/);
  const privateFile = await readFile(path.join(mirrorDir, "agents", AGENT_A, "PRIVATE.md"), "utf8");
  assert.doesNotMatch(privateFile, /Note 0/, "agent B's private notes are not in agent A's folder");
  const soulFile = await readFile(path.join(mirrorDir, "agents", AGENT_A, "SOUL.md"), "utf8");
  assert.match(soulFile, /Be careful and brief/);
});
