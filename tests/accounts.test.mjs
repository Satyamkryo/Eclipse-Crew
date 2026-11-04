import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cleanupCrewDatabase, createCrewDatabase } from "./crew-db.mjs";

const unwrap = (module) => module.default ?? module;

const handle = await createCrewDatabase();
test.after(async () => {
  try {
    const { getDatabase } = unwrap(await import("../db/client.ts"));
    const db = await getDatabase().catch(() => null);
    await db?.$client?.end?.().catch(() => {});
  } catch { /* routes never connected */ }
  await cleanupCrewDatabase(handle);
});

const skip = handle.skip;
const ORIGIN = "http://127.0.0.1:3000";
const authed = (token, extra = {}) => ({ Cookie: `eclipse_session=${token}`, Origin: ORIGIN, ...extra });
const post = (path, token, body) => new Request(`${ORIGIN}${path}`, {
  method: "POST", headers: { ...authed(token), "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const get = (path, token) => new Request(`${ORIGIN}${path}`, { headers: authed(token) });

async function makeSession(pool, ownerId) {
  const token = randomBytes(32).toString("hex");
  const csrf = randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO sessions(id, owner_id, token_hash, csrf_token, expires_at) VALUES ($1,$2,$3,$4, now() + interval '1 hour')",
    [randomUUID(), ownerId, createHash("sha256").update(token).digest("hex"), csrf],
  );
  return { token, csrf };
}

test("TASK-092: three accounts are created; duplicate logins are refused", { skip }, async () => {
  const account = unwrap(await import("../scripts/account.mjs"));
  const { hashPassword } = unwrap(await import("../lib/auth/password.ts"));
  const A = await account.createOwnerAccount(handle.app, unwrap(await import("../db/schema.ts")),
    hashPassword, { login: "Judge1@Example.Test", password: "judge-one-secret" });
  const B = await account.createOwnerAccount(handle.app, unwrap(await import("../db/schema.ts")),
    hashPassword, { login: "judge2@example.test", timezone: "Asia/Kolkata", password: "judge-two-secret" });
  const C = await account.createOwnerAccount(handle.app, unwrap(await import("../db/schema.ts")),
    hashPassword, { login: "judge3@example.test", password: "judge-three-secret" });
  assert.equal(A.login, "judge1@example.test");
  assert.equal(A.timezone, "UTC");
  assert.equal(A.id, (await handle.adminPool.query("SELECT owner_id FROM owner WHERE id=$1", [A.id])).rows[0].owner_id);
  assert.equal(B.timezone, "Asia/Kolkata");
  await assert.rejects(account.createOwnerAccount(handle.app, unwrap(await import("../db/schema.ts")),
    hashPassword, { login: "JUDGE1@example.test", password: "another-secret" }), /already taken/);
  const listed = await account.listOwnerAccounts(handle.app, unwrap(await import("../db/schema.ts")));
  assert.deepEqual(listed.map((row) => row.login).sort(),
    ["judge1@example.test", "judge2@example.test", "judge3@example.test"]);
  assert.ok(listed.every((row) => row.createdAt instanceof Date), "list exposes logins and dates only");
  // The disposable database grants the runtime role exactly what the cross-owner checks below need.
  // REVOKE TEMPORARY satisfies the runtime role verification in db/client.ts (no temp tables are used here).
  await handle.adminPool.query("REVOKE TEMPORARY ON DATABASE postgres FROM PUBLIC");
  await handle.adminPool.query("GRANT SELECT ON step_evidence, checkpoints, memory_versions TO eclipse_app");
  await handle.adminPool.query("GRANT SELECT, INSERT ON memory_entries TO eclipse_app");
  await handle.adminPool.query("GRANT SELECT, INSERT, UPDATE ON check_ins TO eclipse_app");
  process.env.TASK092_OWNERS = JSON.stringify({ A: A.id, B: B.id, C: C.id });
});

function owners() {
  return JSON.parse(process.env.TASK092_OWNERS);
}

test("TASK-092: setup stays closed while accounts exist", { skip }, async () => {
  const { POST } = unwrap(await import("../app/api/auth/setup/route.ts"));
  const response = await POST(post("/api/auth/setup", "0".repeat(64), { login: "late@example.test", password: "late-secret-1" }));
  assert.equal(response.status, 404);
});

test("TASK-092: each account authenticates; wrong passwords and unknown emails are refused alike", { skip }, async () => {
  const { verifyPassword } = unwrap(await import("../lib/auth/password.ts"));
  const { POST } = unwrap(await import("../app/api/auth/login/route.ts"));
  const { resetRateLimit } = unwrap(await import("../lib/auth/rate-limit.ts"));
  resetRateLimit();
  const { A, B, C } = owners();
  const passwords = { [A]: "judge-one-secret", [B]: "judge-two-secret", [C]: "judge-three-secret" };
  const logins = { [A]: "judge1@example.test", [B]: "judge2@example.test", [C]: "judge3@example.test" };
  for (const id of [A, B, C]) {
    const { rows } = await handle.adminPool.query("SELECT password_hash FROM owner WHERE id=$1", [id]);
    assert.equal(await verifyPassword(rows[0].password_hash, passwords[id]), true);
    const wrong = await POST(post("/api/auth/login", "0".repeat(64), { login: logins[id], password: "wrong-password" }));
    assert.equal(wrong.status, 401);
  }
  resetRateLimit();
  const unknown = await POST(post("/api/auth/login", "0".repeat(64), { login: "nobody@example.test", password: "wrong-password" }));
  assert.equal(unknown.status, 401);
  const malformed = await POST(post("/api/auth/login", "0".repeat(64), { login: "not-an-email", password: "x" }));
  assert.equal(malformed.status, 401);
  resetRateLimit();
});

test("TASK-092: five failures lock one login; the others keep signing in", { skip }, async () => {
  const { POST } = unwrap(await import("../app/api/auth/login/route.ts"));
  const { resetRateLimit } = unwrap(await import("../lib/auth/rate-limit.ts"));
  resetRateLimit();
  const bad = (login) => POST(post("/api/auth/login", "0".repeat(64), { login, password: "wrong-password" }));
  for (let i = 0; i < 5; i++) assert.equal((await bad("judge1@example.test")).status, 401);
  const locked = await bad("judge1@example.test");
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get("retry-after")) > 0);
  assert.equal((await bad("judge2@example.test")).status, 401, "judge2 is unaffected by judge1's lockout");
  const { rows } = await handle.adminPool.query("SELECT count(*)::int AS n FROM owner");
  assert.equal(rows[0].n, 3, "no account was disturbed by the lockout");
  resetRateLimit();
});

test("TASK-092: one account cannot read or touch another account's agents, chats, runs or memory", { skip }, async () => {
  const { A, B } = owners();
  const agentA = randomUUID();
  const chatA = randomUUID();
  const messageA = randomUUID();
  const runA = randomUUID();
  const stepA = randomUUID();
  await handle.adminPool.query(
    "INSERT INTO agents(id, owner_id, name, role, soul_md, status, daily_budget_cents, monthly_budget_cents) VALUES ($1,$2,'Ada','Researcher','Be careful.','active',10000,100000)",
    [agentA, A]);
  await handle.adminPool.query("INSERT INTO agent_policies(agent_id, owner_id) VALUES ($1,$2)", [agentA, A]);
  await handle.adminPool.query("INSERT INTO chat_sessions(id, owner_id, agent_id) VALUES ($1,$2,$3)", [chatA, A, agentA]);
  await handle.adminPool.query(
    "INSERT INTO messages(id, owner_id, session_id, role, card_type, content, source_tag) VALUES ($1,$2,$3,'user','message','{\"type\":\"message\",\"text\":\"hello\"}'::jsonb,'user')",
    [messageA, A, chatA]);
  await handle.adminPool.query(
    "INSERT INTO runs(id, owner_id, agent_id, header_json, header_hash, key_id, public_key, started_at) VALUES ($1,$2,$3,'{}',$4,'sha256:'||$5,'k',now())",
    [runA, A, agentA, "a".repeat(64), "b".repeat(64)]);
  await handle.adminPool.query(
    "INSERT INTO steps(id, owner_id, run_id, idx, receipt_json, receipt_hash, prev_hash) VALUES ($1,$2,$3,1,'{}',$4,$5)",
    [stepA, A, runA, "c".repeat(64), "a".repeat(64)]);
  await handle.adminPool.query(
    "INSERT INTO memory_entries(id, owner_id, doc, scope, title, body, author) VALUES ($1,$2,'user','global','Timezone','IST','owner')",
    [randomUUID(), A]);
  const sessionA = await makeSession(handle.adminPool, A);
  const sessionB = await makeSession(handle.adminPool, B);
  const tokenA = sessionA.token;
  const tokenB = sessionB.token;

  const messages = unwrap(await import("../app/api/agents/[agentId]/messages/route.ts"));
  const asB = await messages.GET(get(`/api/agents/${agentA}/messages`, tokenB), { params: Promise.resolve({ agentId: agentA }) });
  assert.equal(asB.status, 404);
  const asA = await messages.GET(get(`/api/agents/${agentA}/messages`, tokenA), { params: Promise.resolve({ agentId: agentA }) });
  assert.equal(asA.status, 200);
  assert.equal((await asA.json()).messages.length, 1);

  const agentRoute = unwrap(await import("../app/api/agents/[agentId]/route.ts"));
  const patchB = await agentRoute.PATCH(
    new Request(`${ORIGIN}/api/agents/${agentA}`, { method: "PATCH",
      headers: { ...authed(tokenB), "Content-Type": "application/json", "x-csrf-token": sessionB.csrf },
      body: JSON.stringify({ name: "Mallory", role: "Intruder", soulMd: "", dailyBudgetUsd: "1.00",
        monthlyBudgetUsd: "10.00", tools: [], domains: [], actions: [], memoryScopes: [] }) }),
    { params: Promise.resolve({ agentId: agentA }) });
  assert.equal(patchB.status, 404, "B's valid session still cannot touch A's agent");

  const runs = unwrap(await import("../app/api/runs/[runId]/route.ts"));
  const runB = await runs.GET(get(`/api/runs/${runA}`, tokenB), { params: Promise.resolve({ runId: runA }) });
  assert.equal(runB.status, 404);
  const runOwn = await runs.GET(get(`/api/runs/${runA}`, tokenA), { params: Promise.resolve({ runId: runA }) });
  assert.equal(runOwn.status, 200);

  const memory = unwrap(await import("../app/api/memory/[agentId]/route.ts"));
  const memoryB = await memory.GET(get(`/api/memory/${agentA}`, tokenB), { params: Promise.resolve({ agentId: agentA }) });
  assert.equal(memoryB.status, 403);
  const memoryA = await memory.GET(get(`/api/memory/${agentA}`, tokenA), { params: Promise.resolve({ agentId: agentA }) });
  assert.equal(memoryA.status, 200);
  assert.match(JSON.stringify(await memoryA.json()), /Timezone/);

  const { listAgentRecords } = unwrap(await import("../lib/agents/data.ts"));
  assert.deepEqual(await listAgentRecords(handle.app, B), [], "B's agent list never contains A's agent");
  assert.equal((await listAgentRecords(handle.app, A)).length, 1);
});

test("TASK-092: the scheduler, memory tidy and check-ins tick every account", { skip, timeout: 120000 }, async () => {
  const { A, B, C } = owners();
  // The tidy hour is owner-local; normalize every account to UTC for a deterministic tick.
  await handle.adminPool.query("UPDATE owner SET timezone='UTC'");
  const spec = { kind: "once", runAt: new Date(Date.now() - 60_000).toISOString(), display: "Once" };
  for (const ownerId of [A, B, C]) {
    const agentId = randomUUID();
    const sessionId = randomUUID();
    const messageId = randomUUID();
    await handle.adminPool.query(
      "INSERT INTO agents(id, owner_id, name, role, soul_md, status, daily_budget_cents, monthly_budget_cents) VALUES ($1,$2,'Tick','Researcher','Be careful.','active',10000,100000)",
      [agentId, ownerId]);
    await handle.adminPool.query("INSERT INTO chat_sessions(id, owner_id, agent_id) VALUES ($1,$2,$3)", [sessionId, ownerId, agentId]);
    await handle.adminPool.query(
      "INSERT INTO messages(id, owner_id, session_id, role, card_type, content, source_tag) VALUES ($1,$2,$3,'user','message','{\"type\":\"message\",\"text\":\"tick\"}'::jsonb,'user')",
      [messageId, ownerId, sessionId]);
    await handle.adminPool.query(
      "INSERT INTO routines(id, owner_id, agent_id, source_message_id, goal, steps, schedule, schedule_spec, timezone, next_run_at, tools, budget_cents, catch_up, active, mode) VALUES ($1,$2,$3,$4,'tick','[]','Once',$5,'UTC', now() - interval '1 minute','{}',100,'run_once',true,'cron')",
      [randomUUID(), ownerId, agentId, messageId, JSON.stringify(spec)]);
    await handle.adminPool.query(
      "INSERT INTO check_ins(id, owner_id, agent_id, name, kind, url, interval_minutes, window_start, window_end, timezone, active, next_check_at) VALUES ($1,$2,$3,'probe','sundance','https://example.com/status',15,0,23,'UTC',true, now() - interval '1 minute')",
      [randomUUID(), ownerId, agentId]);
  }
  const scheduler = unwrap(await import("../lib/routines/scheduler.ts"));
  const ticked = await scheduler.tickRoutines(handle.app, async () => true, new Date());
  assert.equal(ticked.routines, 3, "every account's due routine is claimed");
  assert.equal(ticked.jobs, 3);
  // 03:15 UTC is inside every account's tidy hour: two queued documents per agent plus one user document.
  const counted = await handle.adminPool.query("SELECT count(*)::int AS n FROM agents GROUP BY owner_id");
  const expectedTidy = counted.rows.reduce((sum, row) => sum + 2 * row.n + 1, 0);
  assert.ok(expectedTidy >= 9, "three accounts hold agents to tidy");
  const tidied = await scheduler.tickMemoryTidy(handle.app, new Date("2026-01-01T03:15:00Z"), async () => true);
  assert.equal(tidied, expectedTidy);
  const runner = unwrap(await import("../lib/check-ins/runner.ts"));
  const deps = {
    probe: async () => ({ fingerprint: "a".repeat(64), snapshot: "hello" }),
    post: async () => undefined,
    wake: () => undefined,
    random: () => 0.5,
  };
  const checked = await runner.tickCheckIns(handle.app, deps, new Date());
  assert.equal(checked.checked, 3, "every account's due check-in is probed");
});

test("TASK-092: the mirror writes one USER.md per account and claims the legacy file once", { skip }, async () => {
  const { A, B } = owners();
  const mirror = unwrap(await import("../lib/memory/mirror.ts"));
  const root = mkdtempSync(join(tmpdir(), "eclipse-mirror-"));
  process.env.MEMORY_MIRROR_DIR = root;
  try {
    await handle.adminPool.query(
      "INSERT INTO memory_entries(id, owner_id, doc, scope, title, body, author) VALUES ($1,$2,'user','global','City','Pune','owner')",
      [randomUUID(), A]);
    await handle.adminPool.query(
      "INSERT INTO memory_entries(id, owner_id, doc, scope, title, body, author) VALUES ($1,$2,'user','global','City','Lisbon','owner')",
      [randomUUID(), B]);
    const { writeFileSync: write, mkdirSync: mkdir } = await import("node:fs");
    // Pre-TASK-092 layout: one shared USER.md and one other agent's folder. The database wins for
    // USER.md; anything the writer does not regenerate (other agents' folders) is preserved, never deleted.
    write(join(root, "USER.md"), "legacy single-account mirror\n");
    mkdir(join(root, "agents", "legacy-agent"), { recursive: true });
    write(join(root, "agents", "legacy-agent", "PERSONA.md"), "legacy persona\n");
    assert.equal((await mirror.scheduleMirror(handle.app, A, null)).ok, true);
    const userA = readFileSync(join(root, A, "USER.md"), "utf8");
    assert.match(userA, /Pune/);
    assert.doesNotMatch(userA, /legacy single-account mirror/, "the database is the source of truth");
    assert.match(readFileSync(join(root, A, "agents", "legacy-agent", "PERSONA.md"), "utf8"), /legacy persona/);
    assert.equal((await mirror.scheduleMirror(handle.app, B, null)).ok, true);
    assert.match(readFileSync(join(root, B, "USER.md"), "utf8"), /Lisbon/);
    assert.doesNotMatch(readFileSync(join(root, B, "USER.md"), "utf8"), /Pune/);
  } finally {
    delete process.env.MEMORY_MIRROR_DIR;
  }
});

test("TASK-092: migration 0039 drops the singleton; check-ins has an explicit runtime grant", () => {
  const sql = readFileSync("drizzle/0039_multi_account.sql", "utf8");
  assert.match(sql, /DROP INDEX "owner_singleton_idx"/);
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
  assert.ok(journal.entries.some((entry) => entry.tag === "0039_multi_account"), "0039 is journaled");
  const migrate = readFileSync("scripts/db-migrate.mjs", "utf8");
  assert.match(migrate, /GRANT SELECT, INSERT, UPDATE ON public\.check_ins TO eclipse_app/);
  const provision = readFileSync("db/provision.sql", "utf8");
  assert.match(provision, /migration_count >= 3 AND migration_count <= 39/);
});
