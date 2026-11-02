import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { buildHeader } from "../lib/receipts/chain.mjs";
import { createReceiptRecorder } from "../lib/receipts/store.ts";
import { loadReceiptSigner } from "../lib/receipts/signer.ts";
import { cancelRun, isRunActive, registerRun } from "../lib/jobs/control.ts";
import { hasNewerAttempt, listJobs, loadJob, loadRunForAction } from "../lib/jobs/data.ts";
import { listUpcoming } from "../lib/jobs/upcoming.ts";
import {
  decodeCursor, encodeCursor, escapeLike, jobListQuerySchema, jobUpcomingQuerySchema, outcomeOf, readRunHeader,
  shortRunId, triggerLabel, triggerOf,
} from "../lib/jobs/view.ts";
import { claimAgent, isAgentBusy, runTask } from "../lib/agent/step-loop.ts";
import { nextRoutineRun } from "../lib/routines/schedule.ts";

const unwrap = (module) => module.default ?? module;
const OWNER = randomUUID();
const OTHER_OWNER = randomUUID();
const AGENT = randomUUID();
const RETRY_AGENT = randomUUID();
const PAGE_AGENT = randomUUID();
const NOW = new Date("2026-11-02T12:00:00.000Z");
const SEED = randomBytes(32).toString("hex");
const SESSION_ID = randomUUID();
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZfJ8AAAAASUVORK5CYII=";

// ---- pure view helpers ----

test("outcome mapping: every run status, verified only when every step passed, unsealed only runs for 15 minutes", () => {
  const started = new Date("2026-11-02T11:00:00.000Z");
  const at = (status, extra = {}) => outcomeOf({ status, sealed: true, startedAt: started, endedAt: new Date("2026-11-02T11:01:00.000Z"), stepResults: ["pass"], now: NOW, ...extra });
  assert.deepEqual(at("finished"), { outcome: "verified", label: "Verified", tone: "success" });
  assert.deepEqual(at("finished", { stepResults: ["pass", "fail"] }), { outcome: "finished", label: "Finished", tone: "success" });
  assert.deepEqual(at("needs_owner"), { outcome: "needs_you", label: "Needs you", tone: "warning" });
  assert.deepEqual(at("budget_paused"), { outcome: "needs_you", label: "Needs you", tone: "warning" });
  assert.deepEqual(at("paused_by_owner"), { outcome: "paused", label: "Paused", tone: "warning" });
  assert.deepEqual(at("scope_blocked"), { outcome: "needs_you", label: "Blocked: outside task", tone: "warning" });
  assert.deepEqual(at("asked_owner"), { outcome: "asked_you", label: "Asked you", tone: "neutral" });
  assert.deepEqual(at("aborted"), { outcome: "canceled", label: "Canceled", tone: "neutral" });
  for (const status of ["step_limit", "token_limit", "time_limit", "repeat_limit", "price_required", "cost_error", "provider_error", "desktop_error", "receipt_error", "unknown_status"]) {
    assert.equal(at(status).outcome, "failed", status);
    assert.equal(at(status).label, "Failed", status);
  }
  assert.equal(outcomeOf({ status: "running", sealed: false, startedAt: new Date("2026-11-02T11:59:00.000Z"), endedAt: null, stepResults: [], now: NOW }).outcome, "running");
  assert.deepEqual(outcomeOf({ status: "running", sealed: false, startedAt: new Date("2026-11-02T11:59:00.000Z"), endedAt: null,
    stepResults: [], now: NOW, waitingForApproval: true }), { outcome: "running", label: "Waiting for approval", tone: "neutral" });
  assert.equal(outcomeOf({ status: "running", sealed: false, startedAt: new Date("2026-11-02T10:00:00.000Z"), endedAt: null,
    stepResults: [], now: NOW, waitingForApproval: true }).label, "Waiting for approval", "a live approval wait outlasts the generic 15-minute window");
  assert.equal(outcomeOf({ status: "running", sealed: false, startedAt: new Date("2026-11-02T10:00:00.000Z"), endedAt: null, stepResults: [], now: NOW }).outcome, "not_sealed");
});

test("triggers, labels, headers and cursors are bounded and strict", () => {
  assert.equal(triggerOf(null, "Open settings"), "chat");
  assert.equal(triggerOf(null, "Replay: Download invoice"), "replay");
  assert.equal(triggerOf("schedule", "anything"), "schedule");
  assert.equal(triggerOf("not-a-trigger", "Open settings"), "chat");
  assert.equal(triggerLabel("schedule"), "Scheduled");
  assert.equal(shortRunId("01234567-89ab-4cde-8f01-23456789abcd"), "run_01234567");
  assert.deepEqual(readRunHeader(JSON.stringify({ agent_name: "Ada", task: "Collect invoices" })), { agentName: "Ada", task: "Collect invoices" });
  assert.deepEqual(readRunHeader("garbage"), { agentName: "", task: "" });
  assert.equal(escapeLike("100%_x\\"), "100\\%\\_x\\\\");

  const cursor = encodeCursor({ startedAt: "2026-11-02T12:00:00.000Z", id: randomUUID() });
  assert.deepEqual(decodeCursor(cursor)?.startedAt.toISOString(), "2026-11-02T12:00:00.000Z");
  for (const bad of ["", "not-base64", cursor.slice(0, -3), Buffer.from(JSON.stringify({ s: "x", id: randomUUID() })).toString("base64url")]) {
    assert.equal(decodeCursor(bad), null, bad);
  }

  assert.equal(jobListQuerySchema.safeParse({}).success, true);
  for (const bad of [
    { bogus: "1" }, { agent: "not-a-uuid" }, { outcome: "done" }, { range: "1y" }, { q: "x".repeat(101) }, { q: "" },
  ]) assert.equal(jobListQuerySchema.safeParse(bad).success, false, JSON.stringify(bad));
  assert.deepEqual(jobListQuerySchema.parse({}), { outcome: "all", range: "7d" });
  assert.equal(jobUpcomingQuerySchema.safeParse({ days: "7" }).success, true);
  for (const bad of [{ days: "2" }, { extra: "1" }, { agent: "nope" }]) assert.equal(jobUpcomingQuerySchema.safeParse(bad).success, false, JSON.stringify(bad));
});

test("the in-process run registry cancels only the owner's live run and forgets it when done", () => {
  const runId = randomUUID();
  const control = registerRun(runId, OWNER, AGENT);
  assert.equal(isRunActive(OWNER, runId), true);
  assert.equal(cancelRun(OTHER_OWNER, runId), "not_running");
  assert.equal(control.signal.aborted, false);
  assert.equal(cancelRun(OWNER, runId), "cancelled");
  assert.equal(control.signal.aborted, true);
  assert.equal(cancelRun(OWNER, runId), "not_running");
  control.done();
  assert.equal(isRunActive(OWNER, runId), false);
  assert.equal(cancelRun(OWNER, runId), "not_running");
});

test("the agent lock answers the retry route's busy check", () => {
  const agentId = randomUUID();
  const release = claimAgent(agentId);
  assert.equal(isAgentBusy(agentId), true);
  release();
  assert.equal(isAgentBusy(agentId), false);
});

// ---- real Postgres ----

const dockerUp = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8", timeout: 30000 }).status === 0;
const container = `eclipse-jobs-${randomBytes(6).toString("hex")}`;
const password = randomBytes(16).toString("hex");
let adminPool;
let appPool;
let app;
let mods = {};

function sha(text) { return createHash("sha256").update(text).digest("hex"); }

test.before(async () => {
  if (!dockerUp) return;
  const started = spawnSync("docker", ["run", "-d", "--name", container, "-e", `POSTGRES_PASSWORD=${password}`, "-p", "127.0.0.1::5432",
    "postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b"], { encoding: "utf8", timeout: 120000 });
  assert.equal(started.status, 0, started.stderr);
  for (let i = 0; i < 40; i++) {
    if (spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres", "-h", "127.0.0.1"]).status === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const port = Number(spawnSync("docker", ["port", container, "5432/tcp"], { encoding: "utf8" }).stdout.trim().split(":").pop());
  for (let i = 0; i < 40 && !adminPool; i++) {
    const candidate = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", password, database: "postgres" });
    try { await candidate.query("select 1"); adminPool = candidate; } catch { await candidate.end().catch(() => {}); await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
  assert.ok(adminPool, "database became reachable");
  // The runtime role must exist before migration 0019, which grants pgboss privileges to it.
  await adminPool.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC; REVOKE TEMPORARY ON DATABASE postgres FROM PUBLIC; REVOKE CREATE ON DATABASE postgres FROM PUBLIC; CREATE ROLE eclipse_app LOGIN PASSWORD '${password}';`);
  const files = readdirSync(new URL("../drizzle", import.meta.url)).filter((file) => /^\d{4}_.*\.sql$/.test(file)).sort();
  for (const file of files) {
    await adminPool.query(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  await adminPool.query(`CREATE SCHEMA IF NOT EXISTS drizzle; GRANT USAGE ON SCHEMA public TO eclipse_app;
    GRANT SELECT ON owner, sessions, agents, runs, steps, cost_entries, run_meta, messages, routines, replay_scripts, skills, approvals TO eclipse_app;
    GRANT INSERT ON runs, steps, run_meta TO eclipse_app;
    GRANT UPDATE ON runs, routines, sessions TO eclipse_app;`);
  appPool = new pg.Pool({ host: "127.0.0.1", port, user: "eclipse_app", password, database: "postgres", max: 4 });
  app = drizzle({ client: appPool });
  process.env.DATABASE_URL = `postgresql://eclipse_app:${password}@127.0.0.1:${port}/postgres`;
  process.env.APP_ORIGIN = "http://127.0.0.1:3000";
  mods = {
    jobs: unwrap(await import("../app/api/jobs/route.ts")),
    upcoming: unwrap(await import("../app/api/jobs/upcoming/route.ts")),
    detail: unwrap(await import("../app/api/jobs/[runId]/route.ts")),
    cancel: unwrap(await import("../app/api/jobs/[runId]/cancel/route.ts")),
    retry: unwrap(await import("../app/api/jobs/[runId]/retry/route.ts")),
    active: unwrap(await import("../app/api/routines/[routineId]/active/route.ts")),
  };
  await adminPool.query(`INSERT INTO owner(id, owner_id, login, password_hash, timezone) VALUES ($1,$1,'owner','hash','Asia/Kolkata')`, [OWNER]);
  for (const [id, name] of [[AGENT, "Invoice Assistant"], [RETRY_AGENT, "Brief Writer"], [PAGE_AGENT, "Pager"]]) {
    await adminPool.query(`INSERT INTO agents(id, owner_id, name, role, soul_md, status, daily_budget_cents, monthly_budget_cents)
      VALUES ($1,$2,$3,'Role','Be careful.','active',10000,100000)`, [id, OWNER, name]);
  }
  await adminPool.query(`INSERT INTO chat_sessions(id,owner_id,agent_id) VALUES ($1,$2,$3)`, [SESSION_ID, OWNER, AGENT]);
  await adminPool.query(`INSERT INTO sessions(id,owner_id,token_hash,csrf_token,expires_at) VALUES ($1,$2,$3,$4,now() + interval '1 hour')`,
    [randomUUID(), OWNER, sha(TOKEN), CSRF]);
});

test.after(async () => {
  // The routes' own cached pool and the routine queue must be closed before the container goes away.
  try {
    const { stopRoutineQueue } = await import("../lib/routines/queue.ts");
    await stopRoutineQueue();
  } catch { /* the queue was never started */ }
  try {
    const { getDatabase } = await import("../db/client.ts");
    const database = await getDatabase();
    await database.$client.end().catch(() => {});
  } catch { /* never reached before the first route call */ }
  await appPool?.end().catch(() => {});
  await adminPool?.end().catch(() => {});
  if (dockerUp) spawnSync("docker", ["rm", "-f", container], { timeout: 30000 });
});

const skip = !dockerUp && "Docker is not available";
const runHeader = (runId, task, agentName = "Invoice Assistant", agentId = AGENT, startedAt = "2026-11-02T10:00:00.000Z") =>
  buildHeader({ runId, agentId, agentName, task, startedAt, keyId: "kid" }).text;

async function insertRun({
  owner = OWNER, agentId = AGENT, task = "Collect monthly invoices", agentName = "Invoice Assistant",
  startedAt = "2026-11-02T10:00:00.000Z", endedAt = "2026-11-02T10:01:00.000Z", status = "finished",
  sealed = true, results = ["pass"], trigger = null, label = null, retryOf = null, routineId = null, costMicroUsd = 0,
} = {}) {
  const runId = randomUUID();
  await adminPool.query(`INSERT INTO runs(id,owner_id,agent_id,header_json,header_hash,key_id,public_key,started_at,status,ended_at,step_count,head_hash,usage,signature)
    VALUES ($1,$2,$3,$4,$5,'kid','pub',$6,$7,$8,$9,$10,$11,$12)`, [
    runId, owner, agentId, runHeader(runId, task, agentName, agentId, startedAt), "a".repeat(64), startedAt, status,
    sealed ? endedAt : null, sealed ? results.length : null, sealed ? "b".repeat(64) : null,
    sealed ? JSON.stringify({ input: 1, output: 1, cached: 0, reasoning: 0 }) : null, sealed ? "sig" : null,
  ]);
  for (let index = 0; index < results.length; index++) {
    await adminPool.query(`INSERT INTO steps(id,owner_id,run_id,idx,receipt_json,receipt_hash,prev_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
      randomUUID(), owner, runId, index + 1,
      JSON.stringify({ idx: index + 1, result: results[index], code: results[index] === "fail" ? "check_failed" : null }),
      "c".repeat(64), "d".repeat(64),
    ]);
  }
  if (costMicroUsd) {
    await adminPool.query(`INSERT INTO cost_entries(id,owner_id,run_id,agent_id,provider_id,call_index,model,tokens_in,tokens_out,tokens_cached,cost_micro_usd,outcome,idempotency_key)
      VALUES ($1,$2,$3,$4,$5,1,'m',10,2,0,$6,'ok',$7)`, [
      randomUUID(), owner, runId, agentId, randomUUID(), costMicroUsd, `cost:${runId}:1`,
    ]);
  }
  if (trigger || label || retryOf || routineId) {
    await adminPool.query(`INSERT INTO run_meta(run_id,owner_id,agent_id,trigger,routine_id,replay_script_id,retry_of,label)
      VALUES ($1,$2,$3,$4,$5,NULL,$6,$7)`, [runId, owner, agentId, trigger ?? "chat", routineId, retryOf, label]);
  }
  return runId;
}

async function createRoutine(goal = "Retry routine") {
  const messageId = randomUUID();
  await adminPool.query(`INSERT INTO messages(id,owner_id,session_id,role,card_type,content,source_tag)
    VALUES ($1,$2,$3,'user','routine',$4,'user')`, [messageId, OWNER, SESSION_ID, { type: "routine" }]);
  const routineId = randomUUID();
  await adminPool.query(`INSERT INTO routines(id,owner_id,agent_id,source_message_id,goal,steps,schedule,schedule_spec,timezone,next_run_at,tools,budget_cents,catch_up,active,mode)
    VALUES ($1,$2,$3,$4,$5,'[]'::jsonb,'Every day at 09:00',$6,'Asia/Kolkata','2026-11-03T03:30:00.000Z','{}'::text[],50,'run_once',true,'cron')`, [
    routineId, OWNER, AGENT, messageId, goal, { kind: "daily", cron: "0 9 * * *", display: "Every day at 09:00" },
  ]);
  return routineId;
}

test("list: owner scope, filters, search with literal % and _, ranges, paging and cost", { skip }, async () => {
  const verified = await insertRun({ task: "Collect monthly invoices", startedAt: "2026-11-02T10:00:00.000Z", trigger: "schedule", label: "Collect monthly invoices", costMicroUsd: 40000 });
  const failed = await insertRun({ task: "Download the 100% report", startedAt: "2026-11-01T10:00:00.000Z", status: "step_limit", results: ["pass", "fail"], costMicroUsd: 90000 });
  const finished = await insertRun({ task: "Under_score task", startedAt: "2026-10-30T10:00:00.000Z", results: ["pass", "fail"] });
  const running = await insertRun({ task: "A long task", startedAt: "2026-11-02T11:59:00.000Z", status: "running", sealed: false, results: [] });
  const notSealed = await insertRun({ task: "Forgotten task", startedAt: "2026-11-02T09:00:00.000Z", status: "running", sealed: false, results: [] });
  const foreign = await insertRun({ owner: OTHER_OWNER, task: "Other owner secret", startedAt: "2026-11-02T11:00:00.000Z", costMicroUsd: 1000 });

  const all = await listJobs(app, OWNER, { outcome: "all", range: "all" }, NOW);
  const ids = all.jobs.map((job) => job.runId);
  assert.deepEqual(new Set(ids), new Set([verified, failed, finished, running, notSealed]), "only the owner's runs");
  assert.equal(ids.includes(foreign), false);
  const byId = new Map(all.jobs.map((job) => [job.runId, job]));
  assert.deepEqual([byId.get(verified).outcome, byId.get(verified).costMicroUsd, byId.get(verified).label, byId.get(verified).trigger], ["verified", 40000, "Collect monthly invoices", "schedule"]);
  assert.equal(byId.get(failed).outcome, "failed");
  assert.equal(byId.get(finished).outcome, "finished");
  assert.equal(byId.get(running).outcome, "running");
  assert.equal(byId.get(notSealed).outcome, "not_sealed");

  assert.deepEqual((await listJobs(app, OWNER, { outcome: "failed", range: "all" }, NOW)).jobs.map((job) => job.runId), [failed]);
  assert.deepEqual((await listJobs(app, OWNER, { outcome: "verified", range: "all" }, NOW)).jobs.map((job) => job.runId), [verified]);
  assert.deepEqual((await listJobs(app, OWNER, { outcome: "finished", range: "all" }, NOW)).jobs.map((job) => job.runId), [finished]);
  assert.deepEqual((await listJobs(app, OWNER, { outcome: "running", range: "all" }, NOW)).jobs.map((job) => job.runId), [running]);

  const day = await listJobs(app, OWNER, { outcome: "all", range: "24h" }, NOW);
  assert.equal(day.jobs.some((job) => job.runId === finished), false, "the 24-hour range excludes an older run");
  assert.equal(day.jobs.some((job) => job.runId === verified), true);
  const week = await listJobs(app, OWNER, { outcome: "all", range: "7d" }, NOW);
  assert.equal(week.jobs.some((job) => job.runId === finished), true);

  assert.deepEqual((await listJobs(app, OWNER, { outcome: "all", range: "all", agent: AGENT }, NOW)).jobs.length, 5);
  assert.deepEqual((await listJobs(app, OWNER, { outcome: "all", range: "all", agent: RETRY_AGENT }, NOW)).jobs.length, 0);
  assert.deepEqual((await listJobs(app, OWNER, { outcome: "all", range: "all", q: "100%" }, NOW)).jobs.map((job) => job.runId), [failed]);
  assert.deepEqual((await listJobs(app, OWNER, { outcome: "all", range: "all", q: "under_score" }, NOW)).jobs.map((job) => job.runId), [finished]);
  assert.deepEqual((await listJobs(app, OWNER, { outcome: "all", range: "all", q: "Brief" }, NOW)).jobs.length, 0);

  for (let index = 0; index < 30; index++) {
    await insertRun({ agentId: PAGE_AGENT, agentName: "Pager", task: `Page ${index}`, startedAt: `2026-11-02T0${Math.floor(index / 10)}:${String(index % 10).padStart(2, "0")}:00.000Z` });
  }
  const first = await listJobs(app, OWNER, { outcome: "all", range: "all", agent: PAGE_AGENT }, NOW);
  assert.equal(first.jobs.length, 25);
  assert.ok(first.nextCursor);
  const second = await listJobs(app, OWNER, { outcome: "all", range: "all", agent: PAGE_AGENT, cursor: first.nextCursor }, NOW);
  assert.equal(second.jobs.length, 5);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.jobs, ...second.jobs].map((job) => job.runId)).size, 30);
});

test("detail: input, output, failed steps, attempts and no other owner's run", { skip }, async () => {
  const parent = await insertRun({ task: "Collect invoices", status: "step_limit", results: ["pass", "fail"] });
  const child = await insertRun({ task: "Collect invoices", retryOf: parent, status: "finished", results: ["pass", "executed"] });
  await adminPool.query(`INSERT INTO messages(id,owner_id,session_id,role,card_type,content,source_tag,run_id)
    VALUES ($1,$2,$3,'agent','message',$4,'agent',$5), ($6,$7,$8,'agent','file',$9,'tool',$10)`, [
    randomUUID(), OWNER, SESSION_ID, { type: "message", text: "Collected two invoices." }, child,
    randomUUID(), OWNER, SESSION_ID, { type: "file", direction: "outbox", name: "invoices.pdf", size: 10, kind: "pdf", sha256: "a".repeat(64) }, child,
  ]);
  const detail = await loadJob(app, OWNER, child, NOW);
  assert.equal(detail.input, "Collect invoices");
  assert.equal(detail.output, "Collected two invoices.");
  assert.deepEqual(detail.files, ["invoices.pdf"]);
  assert.deepEqual(detail.attempts.map((attempt) => attempt.runId), [parent, child]);
  assert.equal(detail.attempts[0].outcome, "failed");
  assert.equal(await loadJob(app, OTHER_OWNER, child, NOW), null);
  assert.equal(await loadJob(app, OWNER, randomUUID(), NOW), null);
  const errors = await loadJob(app, OWNER, parent, NOW);
  assert.deepEqual(errors.errors, [{ idx: 2, result: "fail", code: "check_failed" }]);
  assert.equal(await hasNewerAttempt(app, OWNER, parent), true);
  assert.equal(await hasNewerAttempt(app, OWNER, child), false);
  assert.equal((await loadRunForAction(app, OWNER, parent, NOW)).trigger, "chat");
});

test("upcoming: local grouping, Asia/Kolkata and the America/New_York DST change, paused routines", { skip }, async () => {
  const message = async () => {
    const id = randomUUID();
    await adminPool.query(`INSERT INTO messages(id,owner_id,session_id,role,card_type,content,source_tag) VALUES ($1,$2,$3,'user','routine',$4,'user')`,
      [id, OWNER, SESSION_ID, { type: "routine" }]);
    return id;
  };
  const insertRoutine = async ({ goal, schedule, spec, timezone, nextRunAt, active = true }) => {
    const id = randomUUID();
    await adminPool.query(`INSERT INTO routines(id,owner_id,agent_id,source_message_id,goal,steps,schedule,schedule_spec,timezone,next_run_at,tools,budget_cents,catch_up,active,mode)
      VALUES ($1,$2,$3,$4,$5,'[]'::jsonb,$6,$7,$8,$9,'{}'::text[],50,'run_once',$10,'cron')`, [
      id, OWNER, AGENT, await message(), goal, schedule, spec, timezone, nextRunAt, active,
    ]);
    return id;
  };

  const kolkataSpec = { kind: "weekdays", cron: "0 9 * * 1-5", display: "Every weekday at 09:00" };
  const kolkataFirst = nextRoutineRun(kolkataSpec, "Asia/Kolkata", new Date("2026-11-02T00:00:00.000Z"));
  assert.equal(kolkataFirst.toISOString(), "2026-11-02T03:30:00.000Z");
  const kolkata = await insertRoutine({ goal: "Morning source brief", schedule: "Every weekday at 09:00", spec: kolkataSpec, timezone: "Asia/Kolkata", nextRunAt: kolkataFirst.toISOString() });

  const nySpec = { kind: "daily", cron: "0 9 * * *", display: "Every day at 09:00" };
  const nyFirst = nextRoutineRun(nySpec, "America/New_York", new Date("2026-03-07T00:00:00.000Z"));
  assert.equal(nyFirst.toISOString(), "2026-03-07T14:00:00.000Z");
  const ny = await insertRoutine({ goal: "New York brief", schedule: "Every day at 09:00", spec: nySpec, timezone: "America/New_York", nextRunAt: nyFirst.toISOString() });
  const paused = await insertRoutine({ goal: "Paused research", schedule: "Every day at 09:00", spec: nySpec, timezone: "Asia/Kolkata", nextRunAt: "2026-11-03T03:30:00.000Z", active: false });

  const view = await listUpcoming(app, OWNER, { days: 7, timezone: "Asia/Kolkata", now: new Date("2026-11-02T00:00:00.000Z") });
  const kolkataRuns = view.days.flatMap((day) => day.runs).filter((run) => run.routineId === kolkata);
  assert.equal(kolkataRuns[0].startAt, "2026-11-02T03:30:00.000Z");
  assert.equal(kolkataRuns[0].timezone, "Asia/Kolkata");
  assert.equal(kolkataRuns[0].catchUp, "run_once");
  assert.equal(kolkataRuns[0].budgetCents, 50);
  assert.equal(view.days.find((day) => day.runs.some((run) => run.routineId === kolkata))?.date, "2026-11-02");
  assert.equal(kolkataRuns.length, 5, "one weekday occurrence per weekday in the next seven days");

  const dst = await listUpcoming(app, OWNER, { days: 7, timezone: "Asia/Kolkata", now: new Date("2026-03-07T00:00:00.000Z") });
  const nyRuns = dst.days.flatMap((day) => day.runs).filter((run) => run.routineId === ny).map((run) => run.startAt);
  assert.equal(nyRuns[0], "2026-03-07T14:00:00.000Z");
  assert.equal(nyRuns[1], "2026-03-08T13:00:00.000Z", "09:00 New York is one hour earlier after the DST change");

  assert.deepEqual(view.paused.map((routine) => routine.routineId), [paused]);
  const onlyAgent = await listUpcoming(app, OWNER, { days: 7, timezone: "Asia/Kolkata", agentId: RETRY_AGENT, now: new Date("2026-11-02T00:00:00.000Z") });
  assert.equal(onlyAgent.days.length, 0);
  assert.equal(onlyAgent.paused.length, 0);
});

// ---- route helpers ----

const TOKEN = randomBytes(32).toString("hex");
const CSRF = randomBytes(32).toString("hex");
const auth = (extra = {}) => ({ cookie: `eclipse_session=${TOKEN}`, ...extra });
const mutation = (extra = {}) => auth({ origin: "http://127.0.0.1:3000", "x-csrf-token": CSRF, ...extra });
const call = (route, { method = "GET", path = "/api/jobs", params, headers = {}, body } = {}) => {
  const handler = typeof route === "function" ? route : route[method];
  return handler(new Request(`http://127.0.0.1:3000${path}`, { method, headers, ...(body === undefined ? {} : { body }) }),
    params ? { params: Promise.resolve(params) } : undefined);
};

test("routes: anonymous calls are refused, only the documented methods exist, and responses are never cached", { skip }, async () => {
  for (const route of Object.values(mods)) assert.equal(route.runtime, "nodejs");
  for (const route of Object.values(mods)) assert.equal(route.dynamic, "force-dynamic");
  assert.equal(mods.jobs.GET instanceof Function, true);
  assert.equal(mods.upcoming.GET instanceof Function, true);
  assert.equal(mods.detail.GET instanceof Function, true);
  assert.equal(mods.cancel.POST instanceof Function, true);
  assert.equal(mods.retry.POST instanceof Function, true);
  assert.equal(mods.active.POST instanceof Function, true);
  for (const [route, method] of [[mods.jobs, "GET"], [mods.upcoming, "GET"], [mods.detail, "GET"], [mods.cancel, "POST"], [mods.retry, "POST"], [mods.active, "POST"]]) {
    for (const other of ["PUT", "PATCH", "DELETE"]) assert.equal(route[other], undefined, `${method} route has no ${other}`);
  }
  const runId = randomUUID();
  const anonymous = [
    await call(mods.jobs),
    await call(mods.upcoming, { path: "/api/jobs/upcoming" }),
    await call(mods.detail, { path: `/api/jobs/${runId}`, params: { runId } }),
    await call(mods.cancel, { method: "POST", path: `/api/jobs/${runId}/cancel`, params: { runId } }),
    await call(mods.retry, { method: "POST", path: `/api/jobs/${runId}/retry`, params: { runId } }),
    await call(mods.active, { method: "POST", path: `/api/routines/${runId}/active`, params: { routineId: runId } }),
  ];
  for (const response of anonymous) {
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
});

test("routes: list and detail are owner-scoped and strict about input", { skip }, async () => {
  const mine = await insertRun({ task: "Visible run", startedAt: "2026-11-02T11:30:00.000Z", costMicroUsd: 25000 });
  const theirs = await insertRun({ owner: OTHER_OWNER, task: "Hidden run", startedAt: "2026-11-02T11:31:00.000Z" });
  const list = await call(mods.jobs, { headers: auth() });
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.ok(body.jobs.some((job) => job.runId === mine));
  assert.equal(body.jobs.some((job) => job.runId === theirs), false);
  for (const query of ["?bogus=1", "?outcome=done", "?agent=nope", "?range=1y", "?cursor=garbage"]) {
    assert.equal((await call(mods.jobs, { path: `/api/jobs${query}`, headers: auth() })).status, 400, query);
  }

  const detail = await call(mods.detail, { path: `/api/jobs/${mine}`, params: { runId: mine }, headers: auth() });
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).summary.runId, mine);
  const foreign = await call(mods.detail, { path: `/api/jobs/${theirs}`, params: { runId: theirs }, headers: auth() });
  assert.equal(foreign.status, 404);
  assert.equal((await call(mods.detail, { path: "/api/jobs/nope", params: { runId: "nope" }, headers: auth() })).status, 400);
  assert.equal((await call(mods.upcoming, { path: "/api/jobs/upcoming?days=2", headers: auth() })).status, 400);
});

test("routes: origin and CSRF are required for mutations; cancel reaches a live run and seals it aborted", { skip }, async () => {
  const finished = await insertRun({ task: "Already done" });
  const noCsrf = await call(mods.cancel, { method: "POST", path: `/api/jobs/${finished}/cancel`, params: { runId: finished }, headers: auth({ origin: "http://127.0.0.1:3000" }) });
  assert.equal(noCsrf.status, 403);
  assert.deepEqual(await noCsrf.json(), { error: "csrf_denied" });
  const badOrigin = await call(mods.cancel, { method: "POST", path: `/api/jobs/${finished}/cancel`, params: { runId: finished }, headers: mutation({ origin: "http://evil.example" }) });
  assert.equal(badOrigin.status, 403);
  assert.deepEqual(await badOrigin.json(), { error: "origin_denied" });
  const notRunning = await call(mods.cancel, { method: "POST", path: `/api/jobs/${finished}/cancel`, params: { runId: finished }, headers: mutation() });
  assert.equal(notRunning.status, 409);
  assert.deepEqual(await notRunning.json(), { error: "not_running" });

  const runId = randomUUID();
  const control = registerRun(runId, OWNER, AGENT);
  const receipts = createReceiptRecorder({ database: app, ownerId: OWNER, agentId: AGENT, agentName: "Invoice Assistant", task: "A long task", signer: loadReceiptSigner(SEED), runId });
  const task = runTask({
    agent: { id: AGENT, name: "Invoice Assistant", role: "Role", soulMd: "s", actions: [] }, task: "A long task",
    model: "m", timezone: "UTC", now: () => NOW, sleep: async () => {}, postCard: async () => {}, receipts, signal: control.signal,
    desktop: { screenshot: async () => ({ base64: PNG, width: 1024, height: 768 }), snapshot: async () => ({ href: "https://a.example/", title: "A", frames: 0, controls: [] }) },
    provider: { kind: "meta", listModels: async () => [], detectCapabilities: async () => ({}), generate: () => new Promise(() => {}) },
  });
  for (let i = 0; i < 100; i++) {
    const row = await adminPool.query("select 1 from runs where id = $1", [runId]);
    if (row.rowCount) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const cancelled = await call(mods.cancel, { method: "POST", path: `/api/jobs/${runId}/cancel`, params: { runId }, headers: mutation() });
  assert.equal(cancelled.status, 200);
  assert.deepEqual(await cancelled.json(), { cancelled: true });
  const result = await task;
  control.done();
  assert.equal(result.outcome, "aborted");
  const row = await adminPool.query("select status, signature from runs where id = $1", [runId]);
  assert.deepEqual([row.rows[0].status, Boolean(row.rows[0].signature)], ["aborted", true]);
  assert.equal(isRunActive(OWNER, runId), false);
});

test("routes: retry refuses verified, running, replay, already-retried and busy runs", { skip }, async () => {
  const verified = await insertRun({ task: "Verified task" });
  const running = await insertRun({ task: "Running task", startedAt: new Date(Date.now() - 60_000).toISOString(), status: "running", sealed: false, results: [] });
  const replay = await insertRun({ task: "Replay: Download invoice", status: "needs_owner", trigger: "replay" });
  const parent = await insertRun({ task: "Failed task", status: "step_limit", results: ["fail"] });
  await insertRun({ task: "Failed task", status: "finished", results: ["pass"], retryOf: parent });
  const busyRun = await insertRun({ task: "Busy task", agentId: RETRY_AGENT, agentName: "Brief Writer", status: "step_limit", results: ["fail"] });

  const send = (runId) => call(mods.retry, { method: "POST", path: `/api/jobs/${runId}/retry`, params: { runId }, headers: mutation() });
  assert.deepEqual(await (await send(verified)).json(), { error: "already_verified" });
  assert.equal((await send(running)).status, 409);
  assert.deepEqual(await (await send(replay)).json(), { error: "not_retryable" });
  assert.deepEqual(await (await send(parent)).json(), { error: "already_retried" });
  const release = claimAgent(RETRY_AGENT);
  assert.deepEqual(await (await send(busyRun)).json(), { error: "agent_busy" });
  release();
  assert.equal((await send(randomUUID())).status, 404);
});

test("routine runs expose their routine and a scheduled retry without one is refused", { skip }, async () => {
  const routineId = await createRoutine();
  const scheduled = await insertRun({ task: "Scheduled retry", status: "step_limit", results: ["fail"], trigger: "schedule", routineId });
  const detail = await loadJob(app, OWNER, scheduled, NOW);
  assert.equal(detail.summary.routineId, routineId);
  assert.equal(detail.summary.trigger, "schedule");
  const action = await loadRunForAction(app, OWNER, scheduled, NOW);
  assert.equal(action.routineId, routineId);
  assert.equal(action.trigger, "schedule");

  const orphan = await insertRun({ task: "Orphan schedule", status: "step_limit", results: ["fail"], trigger: "schedule" });
  const refused = await call(mods.retry, {
    method: "POST", path: `/api/jobs/${orphan}/retry`, params: { runId: orphan }, headers: mutation(),
  });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: "not_retryable" });

  const { routineJobSchema } = await import("../lib/routines/queue.ts");
  const base = { ownerId: OWNER, routineId, agentId: AGENT, executionId: randomUUID() };
  assert.equal(routineJobSchema.safeParse({ ...base, trigger: "run_now", retryOf: scheduled }).success, true);
  assert.equal(routineJobSchema.safeParse({ ...base, trigger: "schedule", scheduledAt: new Date().toISOString(), retryOf: scheduled }).success, true);
  assert.equal(routineJobSchema.safeParse({ ...base, trigger: "run_now", retryOf: "not-a-uuid" }).success, false);
});

test("a scheduled retry queues the routine with retry_of", { skip }, async () => {
  const routineId = await createRoutine("Retry queue routine");
  const original = await insertRun({ task: "Scheduled retry", status: "step_limit", results: ["fail"], trigger: "schedule", routineId });
  const response = await call(mods.retry, {
    method: "POST", path: `/api/jobs/${original}/retry`, params: { runId: original }, headers: mutation(),
  });
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.started, true);
  assert.equal(typeof body.executionId, "string");
  const job = await adminPool.query("select data from pgboss.job where id = $1", [body.executionId]);
  assert.equal(job.rowCount, 1);
  assert.deepEqual([job.rows[0].data.trigger, job.rows[0].data.retryOf, job.rows[0].data.routineId], ["run_now", original, routineId]);
});

test("run_meta is insert-only for the app role: read and add once, never rewrite or delete", { skip }, async () => {
  const runId = await insertRun({ task: "Metadata grant target" });
  const inserted = await appPool.query("insert into run_meta(run_id,owner_id,agent_id,trigger) values ($1,$2,$3,'chat') returning run_id", [runId, OWNER, AGENT]);
  assert.equal(inserted.rowCount, 1);
  const read = await appPool.query("select trigger, label from run_meta where run_id = $1", [runId]);
  assert.deepEqual([read.rows[0].trigger, read.rows[0].label], ["chat", null]);
  await assert.rejects(() => appPool.query("update run_meta set label = 'changed' where run_id = $1", [runId]), /permission denied/);
  await assert.rejects(() => appPool.query("delete from run_meta where run_id = $1", [runId]), /permission denied/);
  await assert.rejects(() => appPool.query("truncate run_meta"), /permission denied|must be owner/);
});

test("routes: pause and resume a routine, and refuse a one-off whose time has passed", { skip }, async () => {
  const message = async () => {
    const id = randomUUID();
    await adminPool.query(`INSERT INTO messages(id,owner_id,session_id,role,card_type,content,source_tag) VALUES ($1,$2,$3,'user','routine',$4,'user')`,
      [id, OWNER, SESSION_ID, { type: "routine" }]);
    return id;
  };
  const insertRoutine = async (spec, timezone, nextRunAt, active = true) => {
    const id = randomUUID();
    await adminPool.query(`INSERT INTO routines(id,owner_id,agent_id,source_message_id,goal,steps,schedule,schedule_spec,timezone,next_run_at,tools,budget_cents,catch_up,active,mode)
      VALUES ($1,$2,$3,$4,'Routine goal','[]'::jsonb,'Every day at 09:00',$5,$6,$7,'{}'::text[],50,'run_once',$8,'cron')`, [
      id, OWNER, AGENT, await message(), spec, timezone, nextRunAt, active,
    ]);
    return id;
  };
  const daily = { kind: "daily", cron: "0 9 * * *", display: "Every day at 09:00" };
  const routineId = await insertRoutine(daily, "Asia/Kolkata", "2026-11-03T03:30:00.000Z");
  const send = (active) => call(mods.active, {
    method: "POST", path: `/api/routines/${routineId}/active`, params: { routineId }, headers: mutation({ "Content-Type": "application/json" }),
    body: JSON.stringify({ active }),
  });
  const paused = await send(false);
  assert.equal(paused.status, 200);
  assert.equal((await adminPool.query("select active from routines where id = $1", [routineId])).rows[0].active, false);
  const resumed = await send(true);
  assert.equal(resumed.status, 200);
  assert.ok(new Date((await resumed.json()).routine.nextRunAt) > new Date());

  const once = await insertRoutine({ kind: "once", runAt: "2026-11-01T03:30:00.000Z", display: "2026-11-01 09:00" }, "Asia/Kolkata", "2026-11-01T03:30:00.000Z", false);
  const expired = await call(mods.active, {
    method: "POST", path: `/api/routines/${once}/active`, params: { routineId: once }, headers: mutation({ "Content-Type": "application/json" }),
    body: JSON.stringify({ active: true }),
  });
  assert.equal(expired.status, 409);
  assert.deepEqual(await expired.json(), { error: "once_expired" });

  const unknown = await call(mods.active, {
    method: "POST", path: `/api/routines/${randomUUID()}/active`, params: { routineId: randomUUID() }, headers: mutation({ "Content-Type": "application/json" }),
    body: JSON.stringify({ active: false }),
  });
  assert.equal(unknown.status, 404);

  const badField = await call(mods.active, {
    method: "POST", path: `/api/routines/${routineId}/active`, params: { routineId }, headers: mutation({ "Content-Type": "application/json" }),
    body: JSON.stringify({ active: false, extra: true }),
  });
  assert.equal(badField.status, 400);
  const oversized = await call(mods.active, {
    method: "POST", path: `/api/routines/${routineId}/active`, params: { routineId }, headers: mutation({ "Content-Type": "application/json" }),
    body: JSON.stringify({ active: false, pad: "x".repeat(2000) }),
  });
  assert.equal(oversized.status, 413);
});
