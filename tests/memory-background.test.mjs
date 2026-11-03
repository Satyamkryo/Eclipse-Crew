import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  needsTidy, reviewSendOptions, tidySendOptions, memoryReviewJobSchema, memoryTidyJobSchema,
  REVIEW_DELAY_SECONDS, TIDY_AT_PERCENT,
} from "../lib/memory/queue.ts";
import { tickMemoryTidy } from "../lib/routines/scheduler.ts";
import { runMemoryTidy, TIDY_INTERVAL_MS, MIN_COVERAGE } from "../lib/memory/tidy.ts";
import { MAX_CHANGES } from "../lib/memory/review.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

test("review waits 120 s, is singleton per agent and capped at five proposals", () => {
  assert.equal(REVIEW_DELAY_SECONDS, 120);
  assert.deepEqual(reviewSendOptions(AGENT), {
    singletonKey: AGENT, startAfter: 120, retryLimit: 1, retryDelay: 30, retryBackoff: false, expireInSeconds: 300,
  });
  const job = { ownerId: OWNER, agentId: AGENT };
  assert.deepEqual(memoryReviewJobSchema.parse(job), job);
  assert.equal(memoryReviewJobSchema.safeParse({ ...job, extra: true }).success, false);
  assert.equal(MAX_CHANGES, 5);
  assert.equal(TIDY_INTERVAL_MS, 6 * 60 * 60_000);
  assert.equal(MIN_COVERAGE, 0.95);
});

test("tidy is idempotent per agent, document and local day, and starts at once by default", () => {
  const job = { ownerId: OWNER, agentId: AGENT, doc: "memory", docKey: `memory:${AGENT}` };
  assert.deepEqual(tidySendOptions(job), {
    singletonKey: `${AGENT}:memory:${AGENT}`,
    startAfter: 0, retryLimit: 1, retryDelay: 30, retryBackoff: false, expireInSeconds: 300,
  });
  const dated = tidySendOptions(job, { id: "memory-tidy:agent:memory:2026-11-04", delaySeconds: 30 });
  assert.match(dated.id, /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(dated.id, tidySendOptions(job, { id: "memory-tidy:agent:memory:2026-11-04" }).id);
  assert.notEqual(dated.id, tidySendOptions(job, { id: "memory-tidy:agent:memory:2026-11-05" }).id);
  assert.notEqual(dated.id, tidySendOptions({ ...job, ownerId: "33333333-3333-4333-8333-333333333333" }, { id: "memory-tidy:agent:memory:2026-11-04" }).id);
  assert.equal(dated.startAfter, 30);
  assert.deepEqual(memoryTidyJobSchema.parse(job), job);
  assert.equal(memoryTidyJobSchema.safeParse({ ...job, doc: "global" }).success, false);
});

test("a document at 85% of its cap is tidied now", () => {
  assert.equal(TIDY_AT_PERCENT, 0.85);
  assert.equal(needsTidy(84_999, 100_000), false);
  assert.equal(needsTidy(85_000, 100_000), true);
  assert.equal(needsTidy(1_000, 0), false);
});

function tidyDatabase(agentId = AGENT) {
  let read = 0;
  return {
    select() {
      const index = read++;
      const value = index === 0
        ? [{ id: OWNER, timezone: "Asia/Kolkata", crewStoppedAt: null }]
        : [{ id: agentId }];
      const q = {
        from() { return q; }, where() { return Promise.resolve(value); }, limit() { return Promise.resolve(value); },
      };
      return q;
    },
    reset() { read = 0; },
  };
}

test("nightly tidy runs at 03:00 in the owner's timezone and nowhere else", async () => {
  const calls = [];
  const enqueue = async (job, options) => { calls.push({ job, options }); return true; };
  const database = tidyDatabase();
  // 03:00 in Asia/Kolkata on 2026-11-04.
  const queued = await tickMemoryTidy(database, new Date("2026-11-03T21:30:00.000Z"), enqueue);
  assert.equal(queued, 3);
  assert.deepEqual(calls.map((call) => call.job.doc), ["memory", "private", "user"]);
  for (const call of calls) assert.match(call.options.id, /^memory-tidy:/);

  calls.length = 0;
  database.reset();
  const offHour = await tickMemoryTidy(database, new Date("2026-11-03T22:30:00.000Z"), enqueue);
  assert.equal(offHour, 0);
  assert.equal(calls.length, 0);
});

test("tidy refuses a second run inside six hours without reading document entries", async () => {
  let selects = 0;
  const database = {
    select() {
      selects += 1;
      if (selects > 1) throw Error("must not read entries within the floor");
      const value = [{ lastTidyAt: { [`memory:${AGENT}`]: new Date(Date.now() - 60 * 60_000).toISOString() } }];
      const q = { from() { return q; }, where() { return q; }, limit() { return Promise.resolve(value); } };
      return q;
    },
  };
  await runMemoryTidy(database, { ownerId: OWNER, agentId: AGENT, doc: "memory", docKey: `memory:${AGENT}` }, "job-1");
  assert.equal(selects, 1);
});

test("real pg-boss queue keeps the delay and atomically deduplicates pending jobs", { timeout: 120_000 }, async (t) => {
  if (process.env.ECLIPSE_MEMORY_QUEUE_E2E !== "1") return t.skip("set ECLIPSE_MEMORY_QUEUE_E2E=1 for a disposable Postgres fixture");
  // Never use an existing DATABASE_URL or app database. Queue semantics are exercised
  // with the installed pg-boss version and the designated non-owning runtime role.
  const name = `eclipse-memory-queue-${randomBytes(6).toString("hex")}`;
  const password = randomBytes(24).toString("hex");
  const label = `eclipse.closeout.memory-queue=${name}`;
  const docker = (...args) => spawnSync("docker", args, { encoding: "utf8", timeout: 30_000 });
  let pool;
  let boss;
  let runtime;
  const originalUrl = process.env.DATABASE_URL;
  const checked = (result) => { assert.equal(result.status, 0, "disposable queue Docker command succeeds"); return result.stdout.trim(); };
  checked(docker("run", "-d", "--name", name, "--label", label, "-e", `POSTGRES_PASSWORD=${password}`,
    "-p", "127.0.0.1::5432", "postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b"));
  try {
    const { default: pg } = await import("pg");
    const { PgBoss } = await import("pg-boss");
    const port = Number(checked(docker("port", name, "5432/tcp")).split(":").pop());
    pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", password, database: "postgres", connectionTimeoutMillis: 1000 });
    let ready = false;
    for (let n = 0; n < 50; n++) {
      try { await pool.query("select 1"); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 200)); }
    }
    assert.ok(ready, "disposable Postgres is ready");
    const installer = new PgBoss({ host: "127.0.0.1", port, user: "postgres", password, database: "postgres", schedule: false });
    try { await installer.start(); } finally { await installer.stop({ graceful: false }); }
    await pool.query(`CREATE ROLE eclipse_app LOGIN PASSWORD '${password}';
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      REVOKE CREATE, TEMP ON DATABASE postgres FROM PUBLIC;
      CREATE SCHEMA drizzle;
      CREATE TABLE public.owner(id uuid PRIMARY KEY);
      GRANT SELECT ON public.owner TO eclipse_app;
      GRANT USAGE ON SCHEMA pgboss TO eclipse_app;
      GRANT ALL ON ALL TABLES IN SCHEMA pgboss TO eclipse_app;
      GRANT ALL ON ALL SEQUENCES IN SCHEMA pgboss TO eclipse_app;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO eclipse_app;`);
    process.env.DATABASE_URL = `postgresql://eclipse_app:${password}@127.0.0.1:${port}/postgres`;
    const { getDatabase } = await import("../db/client.ts");
    runtime = await getDatabase();
    const { getMemoryQueue, enqueueMemoryReview, enqueueMemoryTidy, MEMORY_REVIEW_QUEUE, MEMORY_TIDY_QUEUE } = await import("../lib/memory/queue.ts");
    boss = await getMemoryQueue();
    const queued = await Promise.all(Array.from({ length: 6 }, () => enqueueMemoryReview(OWNER, AGENT, undefined, 120)));
    assert.equal(queued.filter(Boolean).length, 1, "concurrent reviews for one agent enqueue exactly once");
    const jobs = await boss.findJobs(MEMORY_REVIEW_QUEUE, {});
    const pending = jobs.filter((job) => job.data?.agentId === AGENT);
    assert.equal(pending.length, 1);
    const startAfter = new Date(pending[0].startAfter).getTime();
    assert.ok(startAfter - Date.now() > 100_000, `startAfter was ${pending[0].startAfter}`);
    assert.deepEqual(await boss.fetch(MEMORY_REVIEW_QUEUE), [], "delayed review cannot execute immediately");
    assert.equal(await enqueueMemoryReview(OWNER, randomUUID(), undefined, 120), true, "other agents have independent pending jobs");
    const tidy = { ownerId: OWNER, agentId: AGENT, doc: "memory", docKey: `memory:${AGENT}` };
    const tidies = await Promise.all(Array.from({ length: 6 }, () => enqueueMemoryTidy(tidy)));
    assert.equal(tidies.filter(Boolean).length, 1, "concurrent tidies for one document enqueue exactly once");
    assert.equal(await enqueueMemoryTidy({ ...tidy, doc: "private", docKey: `private:${AGENT}` }), true, "other documents remain independent");
    const [activeTidy] = await boss.fetch(MEMORY_TIDY_QUEUE);
    assert.ok(activeTidy);
    await boss.complete(MEMORY_TIDY_QUEUE, activeTidy.id);
    const completed = await boss.findJobs(MEMORY_TIDY_QUEUE, { id: activeTidy.id });
    assert.equal(completed[0].state, "completed");
    assert.equal(await enqueueMemoryTidy(activeTidy.data), true, "completed jobs do not permanently block the next tidy");
    const nightlyDatabase = tidyDatabase(randomUUID());
    assert.equal(await tickMemoryTidy(nightlyDatabase, new Date("2026-11-03T21:30:00.000Z")), 3,
      "03:00 local tick inserts all three actual pg-boss jobs");
    nightlyDatabase.reset();
    assert.equal(await tickMemoryTidy(nightlyDatabase, new Date("2026-11-03T21:31:00.000Z")), 0,
      "repeated nightly ticks do not create duplicate jobs");
    const activeTidies = await boss.fetch(MEMORY_TIDY_QUEUE, { batchSize: 100 });
    await boss.complete(MEMORY_TIDY_QUEUE, activeTidies.map(job => job.id));
    nightlyDatabase.reset();
    assert.equal(await tickMemoryTidy(nightlyDatabase, new Date("2026-11-03T21:32:00.000Z")), 0,
      "completed nightly jobs also keep same-day ticks idempotent");
    nightlyDatabase.reset();
    assert.equal(await tickMemoryTidy(nightlyDatabase, new Date("2026-11-04T21:30:00.000Z")), 3,
      "the next local day can schedule fresh nightly jobs");
  } finally {
    await boss?.stop({ graceful: false }).catch(() => {});
    await runtime?.$client.end().catch(() => {});
    await pool?.end().catch(() => {});
    if (originalUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalUrl;
    assert.equal(checked(docker("inspect", "--format", '{{ index .Config.Labels "eclipse.closeout.memory-queue" }}', name)), name);
    checked(docker("rm", "-f", "-v", name));
  }
});
