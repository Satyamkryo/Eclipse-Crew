import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { checkOrigin, contentWords, coverage } from "../lib/memory/gate.ts";

const docker = (args, input) => spawnSync("docker", args, { encoding: "utf8", input, timeout: 120000 });
const dockerUp = docker(["version", "--format", "{{.Server.Version}}"]).status === 0;
const name = `eclipse-gate-${randomBytes(6).toString("hex")}`;
const password = randomBytes(16).toString("hex");
const OWNER = randomUUID();
const AGENT = randomUUID();
const SESSION = randomUUID();
let adminPool; let appPool; let app; let changes; let store;

const skip = !dockerUp && "Docker is not available";

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
  for (let i = 0; i < 40 && !adminPool; i++) {
    const candidate = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", password, database: "postgres" });
    try { await candidate.query("select 1"); adminPool = candidate; } catch { await candidate.end().catch(() => {}); await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
  assert.ok(adminPool);
  for (const file of ["0000_solid_risque.sql", "0003_kind_jocasta.sql", "0004_crazy_shocker.sql", "0023_audit_log.sql", "0024_memory_storage.sql", "0025_memory_changes.sql"]) {
    const migration = readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8").replaceAll("--> statement-breakpoint", "");
    await adminPool.query(migration);
  }
  await adminPool.query(`ALTER TABLE "memory_changes" ADD COLUMN "op" text DEFAULT 'add' NOT NULL;
    ALTER TABLE "memory_changes" ADD COLUMN "quote" text;
    ALTER TABLE "agent_policies" ADD COLUMN "memory_mode" text DEFAULT 'auto' NOT NULL;
    ALTER TABLE "memory_entries" ADD COLUMN "last_confirmed_at" timestamp with time zone;
    ALTER TABLE "memory_versions" ADD COLUMN "batch_id" uuid;`);
  await adminPool.query(`CREATE ROLE app_role LOGIN PASSWORD '${password}';
    GRANT SELECT, INSERT, UPDATE ON memory_entries TO app_role;
    GRANT SELECT, INSERT ON memory_versions TO app_role;
    GRANT SELECT, INSERT, UPDATE ON memory_changes TO app_role;
    GRANT SELECT ON agents TO app_role;
    GRANT SELECT ON agent_policies TO app_role;
    GRANT SELECT, INSERT ON messages TO app_role;
    GRANT SELECT, INSERT ON chat_sessions TO app_role;
    GRANT SELECT, INSERT ON audit_log TO app_role;`);
  await adminPool.query("INSERT INTO owner(id,owner_id,login,password_hash,timezone) VALUES ($1,$1,'owner','hash','UTC')", [OWNER]);
  await adminPool.query("INSERT INTO agents(id,owner_id,name,role,soul_md,status,daily_budget_cents,monthly_budget_cents) VALUES ($1,$2,'Ada','Researcher','Be careful.','active',100,1000)", [AGENT, OWNER]);
  await adminPool.query("INSERT INTO agent_policies(agent_id,owner_id,tools,domains,actions,memory_scopes) VALUES ($1,$2,'{}','{}','{}','{global,agent,private}')", [AGENT, OWNER]);
  await adminPool.query("INSERT INTO chat_sessions(id,owner_id,agent_id) VALUES ($1,$2,$3)", [SESSION, OWNER, AGENT]);
  appPool = new pg.Pool({ host: "127.0.0.1", port, user: "app_role", password, database: "postgres" });
  app = drizzle({ client: appPool });
  changes = await import("../lib/memory/changes.ts");
  store = await import("../lib/memory/store.ts");
});

test.after(async () => {
  await appPool?.end().catch(() => {}); await adminPool?.end().catch(() => {});
  if (dockerUp) docker(["rm", "-f", name]);
});

async function say(text) {
  await adminPool.query("INSERT INTO messages(id,owner_id,session_id,role,card_type,content,source_tag) VALUES ($1,$2,$3,'user','message',$4,'user')",
    [randomUUID(), OWNER, SESSION, JSON.stringify({ text })]);
}
const propose = (overrides) => changes.proposeMemory(app, {
  ownerId: OWNER, agentId: AGENT, runId: null, queuedThisRun: 0, scope: "agent",
  title: "Lives in Berlin", body: "Lives in Berlin now.", reason: "Owner said so", ...overrides,
});

test("content words ignore stop words and compare the owner's words", () => {
  assert.deepEqual(contentWords("The owner lives in Berlin"), ["owner", "live", "berlin"]);
  assert.equal(coverage("Lives in Berlin now", "I live in Berlin now"), 1);
  assert.equal(coverage("Lives in Paris", "I live in Berlin now"), 0.5);
});

test("the gate only accepts a real owner quote with 90% word coverage", { skip }, async () => {
  assert.equal((await checkOrigin(app, OWNER, { title: "Lives in Berlin", text: "Lives in Berlin now.", quote: "I live in Berlin now" }, "auto")).decision, "ask", "no matching message yet");
  await say("I live in Berlin now");
  const auto = await checkOrigin(app, OWNER, { title: "Lives in Berlin", text: "Lives in Berlin now.", quote: "I live in Berlin now" }, "auto");
  assert.equal(auto.decision, "auto");
  assert.ok(auto.messageId);
  assert.equal((await checkOrigin(app, OWNER, { title: "Lives in Tokyo", text: "Lives in Tokyo now.", quote: "I live in Berlin now" }, "auto")).decision, "ask");
  assert.equal((await checkOrigin(app, OWNER, { title: "Lives in Berlin", text: "Lives in Berlin now.", quote: "I live in Berlin now" }, "ask")).decision, "ask");
  assert.equal((await checkOrigin(app, OWNER, { title: "X", text: "Y", quote: "short" }, "auto")).decision, "ask");
});

test("a quoted owner fact is saved at once with Undo; a fact without a quote waits", { skip }, async () => {
  await say("I live in Berlin now");
  const added = await propose({ quote: "I live in Berlin now" });
  assert.equal(added.ok, true);
  assert.equal(added.applied, true);
  let view = await store.listMemory(app, OWNER, AGENT);
  assert.equal(view.memory.entries.length, 1);
  assert.equal(view.memory.entries[0].title, "Lives in Berlin");
  assert.equal(view.memory.entries[0].sourceLabel, "From your message");
  assert.equal((await changes.undoMemoryVersion(app, OWNER, added.versionId)).ok, true);
  view = await store.listMemory(app, OWNER, AGENT);
  assert.equal(view.memory.entries.length, 0, "Undo removes the auto-saved entry");

  await say("I live in Berlin now");
  const queued = await propose({ title: "Vendor portal", body: "Use the Northstar page.", quote: null });
  assert.equal(queued.ok, true);
  assert.equal(queued.applied, false);
  assert.equal((await store.listMemory(app, OWNER, AGENT)).memory.entries.length, 0);
});

test("a quoted change replaces a titled entry, and a pinned entry is never changed", { skip }, async () => {
  await say("I live in Berlin now");
  const added = await propose({ quote: "I live in Berlin now" });
  assert.equal(added.ok, true);
  const entryId = (await store.listMemory(app, OWNER, AGENT)).memory.entries.find((entry) => entry.title === "Lives in Berlin").id;

  await say("I live in Paris now");
  const replaced = await propose({ op: "replace", title: "Lives in Berlin", body: "Lives in Paris now.", quote: "I live in Paris now" });
  assert.equal(replaced.ok, true, JSON.stringify(replaced));
  assert.equal(replaced.applied, true, JSON.stringify(replaced));
  assert.equal((await store.listMemory(app, OWNER, AGENT)).memory.entries[0].body, "Lives in Paris now.");

  await store.applyMemoryChange(app, OWNER, { op: "pin", entryId, author: "owner" });
  await say("I live in Rome now");
  const pinned = await propose({ op: "replace", title: "Lives in Berlin", body: "Lives in Rome now.", quote: "I live in Rome now" });
  assert.deepEqual([pinned.ok, pinned.code], [false, "pinned"]);
  assert.equal((await store.listMemory(app, OWNER, AGENT)).memory.entries[0].body, "Lives in Paris now.");
});

test("in ask mode every change waits, and a forget applies only through the gate", { skip }, async () => {
  await say("I prefer dark mode in the editor");
  const unquoted = await propose({ title: "Unquoted request", body: "Keep this request pending.", quote: null });
  assert.equal(unquoted.ok, true);
  assert.equal(unquoted.applied, false);

  await say("My project is named Eclipse Crew");
  const pinnedEntry = await propose({ title: "Project name", body: "Project is named Eclipse Crew.", quote: "My project is named Eclipse Crew" });
  assert.equal(pinnedEntry.applied, true);
  const entryId = (await store.listMemory(app, OWNER, AGENT)).memory.entries.find((entry) => entry.title === "Project name").id;
  await store.applyMemoryChange(app, OWNER, { op: "pin", entryId, author: "owner" });

  await adminPool.query("UPDATE agent_policies SET memory_mode = 'ask' WHERE agent_id = $1", [AGENT]);
  await say("I prefer bullet points in replies");
  const queued = await propose({ title: "Prefers bullet points", body: "Prefers bullet points in replies.", quote: "I prefer bullet points in replies" });
  assert.equal(queued.ok, true);
  assert.equal(queued.applied, false);
  const pendingIds = (await changes.listPending(app, OWNER, AGENT)).map((change) => change.id);
  assert.ok(pendingIds.includes(unquoted.changeId), "the unquoted request created in this test is still pending");
  assert.ok(pendingIds.includes(queued.changeId), "the ask-mode request created in this test is pending");

  await adminPool.query("UPDATE agent_policies SET memory_mode = 'auto' WHERE agent_id = $1", [AGENT]);
  const approved = await changes.decideMemoryChange(app, OWNER, queued.changeId, "approve");
  assert.equal(approved.ok, true);
  const forgotten = await propose({ op: "forget", title: "Prefers bullet points", body: "Prefers bullet points in replies.", quote: "I prefer bullet points in replies" });
  assert.equal(forgotten.ok, true);
  assert.equal(forgotten.applied, true);
  const remaining = (await store.listMemory(app, OWNER, AGENT)).memory.entries;
  assert.ok(remaining.some((entry) => entry.id === entryId && entry.title === "Project name"), "the pinned entry created in this test is untouched");
  assert.ok(!remaining.some((entry) => entry.title === "Prefers bullet points"), "the approved fact was forgotten");
});
