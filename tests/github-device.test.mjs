import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const docker = (args) => spawnSync("docker", args, { encoding: "utf8", timeout: 120_000 });
const dockerUp = docker(["version", "--format", "{{.Server.Version}}"]).status === 0;
const name = `eclipse-github-device-${randomBytes(6).toString("hex")}`;
const password = randomBytes(16).toString("hex");
const OWNER = randomUUID();
const OTHER = randomUUID();
const AGENT = randomUUID();
const SECRET = "cd".repeat(32);
const DEVICE = "device-code-0123456789abcdef";
const ACCESS = "ghu_ACCESS_TOKEN_0123456789abcdef";
const REFRESH = "ghr_REFRESH_TOKEN_0123456789abcdef";
const NEW_ACCESS = "ghu_NEW_ACCESS_0123456789abcdef";
const NEW_REFRESH = "ghr_NEW_REFRESH_0123456789abcdef";
const NOW = new Date("2026-11-03T10:00:00.000Z");

let adminPool; let appPool; let database; let device; let data;

test.before(async () => {
  if (!dockerUp) return;
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
  process.env.RECEIPT_SIGNING_KEY = randomBytes(32).toString("hex");
  process.env.EGRESS_PROXY_SECRET = SECRET;
  process.env.GITHUB_APP_CLIENT_ID = "Iv1.eclipse-crew-test";
  process.env.GITHUB_APP_SLUG = "eclipse-crew";
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.github_device_flows TO app_role;
    GRANT SELECT, INSERT ON public.audit_log TO app_role;`);
  await adminPool.query(`INSERT INTO public.owner(id,owner_id,login,password_hash,timezone) VALUES ($1,$1,'owner','hash','UTC')`, [OWNER]);
  await adminPool.query(`INSERT INTO public.owner(id,owner_id,login,password_hash,timezone) VALUES ($1,$1,'other','hash','UTC')`, [OTHER]);
  await adminPool.query(`INSERT INTO public.agents(id,owner_id,name,role,soul_md,status,daily_budget_cents,monthly_budget_cents)
    VALUES ($1,$2,'A','role','soul','active',100,1000)`, [AGENT, OWNER]);
  appPool = new pg.Pool({ host: "127.0.0.1", port, user: "app_role", password, database: "postgres" });
  database = drizzle({ client: appPool });
  device = await import("../lib/connections/github-device.ts");
  data = await import("../lib/connections/data.ts");
});

test.after(async () => {
  await appPool?.end().catch(() => {}); await adminPool?.end().catch(() => {});
  if (dockerUp) docker(["rm", "-f", name]);
});

const skip = !dockerUp && "Docker is not available";
const flush = () => adminPool.query("TRUNCATE public.github_device_flows, public.connections, public.audit_log");

let nextAnswer = { device_code: DEVICE, user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 10 };
function deps({ answer = () => nextAnswer, onBody = () => {}, refreshDelay = () => [] } = {}) {
  const bodies = [];
  const queued = [];
  const respond = (body) => body.operation === "code" ? nextAnswer : answer(body);
  return {
    bodies, queued,
    dependencies: {
      baseUrl: "http://proxy.test", secret: SECRET, now: () => NOW,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body); bodies.push(body); onBody(body);
        return new Response(JSON.stringify(respond(body)), { status: 200, headers: { "content-type": "application/json" } });
      },
      enqueuePoll: async (...args) => { queued.push(["poll", ...args]); return true; },
      enqueueRefresh: async (...args) => { queued.push(["refresh", ...args, ...refreshDelay()]); return true; },
      pushCredentials: async () => true,
    },
  };
}

test("a device start stores the code encrypted and shows only the short code and link", { skip }, async () => {
  await flush();
  const run = deps();
  const flow = await device.startGithubDevice(database, OWNER, { agentId: AGENT }, run.dependencies);
  assert.equal(flow.status, "pending");
  assert.equal(flow.userCode, "ABCD-1234");
  assert.equal(flow.verificationUri, "https://github.com/login/device");
  assert.equal(flow.installUrl, "https://github.com/apps/eclipse-crew/installations/new");
  assert.equal(JSON.stringify(flow).includes(DEVICE), false, "the device code never reaches the UI");
  assert.deepEqual(run.bodies, [{ operation: "code", clientId: "Iv1.eclipse-crew-test" }]);
  assert.deepEqual(run.queued, [["poll", flow.id, 10]]);
  const rows = await adminPool.query("select encrypted_device_code, status from public.github_device_flows where id = $1", [flow.id]);
  assert.equal(rows.rows[0].status, "pending");
  assert.notEqual(rows.rows[0].encrypted_device_code, DEVICE);
  assert.equal(rows.rows[0].encrypted_device_code.includes(DEVICE), false);
  await assert.rejects(() => device.getGithubDeviceFlow(database, OTHER, flow.id), (error) => error.code === "not_found");
});

test("pending and slow_down reschedule; a second Connect replaces the pending flow", { skip }, async () => {
  await flush();
  let mode = "pending";
  const run = deps({ answer: () => mode === "pending" ? { error: "authorization_pending" } : { error: "slow_down" } });
  const flow = await device.startGithubDevice(database, OWNER, { agentId: AGENT }, run.dependencies);
  assert.deepEqual(await device.pollGithubDevice(database, flow.id, run.dependencies), { delay: 10 });
  mode = "slow_down";
  assert.deepEqual(await device.pollGithubDevice(database, flow.id, run.dependencies), { delay: 15, intervalSeconds: 15 });
  const row = await adminPool.query("select interval_seconds from public.github_device_flows where id = $1", [flow.id]);
  assert.equal(row.rows[0].interval_seconds, 15);
  const replacement = await device.startGithubDevice(database, OWNER, { agentId: AGENT }, run.dependencies);
  const old = await adminPool.query("select status, error_code from public.github_device_flows where id = $1", [flow.id]);
  assert.equal(old.rows[0].status, "expired");
  assert.equal(old.rows[0].error_code, "replaced");
  assert.notEqual(replacement.id, flow.id);
});

test("terminal GitHub errors stop the flow once and are never retried", { skip }, async () => {
  await flush();
  for (const [error, status] of [["access_denied", "denied"], ["expired_token", "expired"], ["bad_verification_code", "expired"]]) {
    const run = deps({ answer: () => ({ error, error_description: "no" }) });
    const flow = await device.startGithubDevice(database, OWNER, { agentId: AGENT }, run.dependencies);
    assert.deepEqual(await device.pollGithubDevice(database, flow.id, run.dependencies), { done: true });
    assert.equal((await device.getGithubDeviceFlow(database, OWNER, flow.id)).status, status);
    assert.deepEqual(await device.pollGithubDevice(database, flow.id, run.dependencies), { done: true });
  }
});

test("a successful poll stores encrypted tokens, makes the connection and schedules the refresh", { skip }, async () => {
  await flush();
  const run = deps({ answer: () => ({ access_token: ACCESS, token_type: "bearer", scope: "", refresh_token: REFRESH, expires_in: 28_800, refresh_token_expires_in: 15_552_000 }) });
  const flow = await device.startGithubDevice(database, OWNER, { agentId: AGENT }, run.dependencies);
  assert.deepEqual(await device.pollGithubDevice(database, flow.id, run.dependencies), { done: true });
  const view = await device.getGithubDeviceFlow(database, OWNER, flow.id);
  assert.equal(view.status, "connected");
  assert.ok(view.connectionId);

  const connection = await data.getConnection(database, OWNER, view.connectionId);
  assert.equal(connection.source, "github_app");
  assert.equal(connection.status, "active");
  assert.equal(connection.tokenHint, "ghu_…cdef");
  assert.notEqual(connection.encryptedToken, ACCESS);
  assert.notEqual(connection.encryptedRefreshToken, REFRESH);
  assert.equal(JSON.stringify(connection).includes(ACCESS), false);
  assert.equal(JSON.stringify(connection).includes(REFRESH), false);
  assert.ok(connection.tokenExpiresAt > NOW);
  assert.ok(connection.refreshExpiresAt > NOW);
  assert.equal(run.queued.filter(([kind]) => kind === "refresh").length, 0, "the scheduler tick, not the connect step, queues the refresh");
  const due = await device.refreshDueConnections(database, new Date(connection.tokenExpiresAt.getTime() - 30 * 60_000), run.dependencies);
  assert.equal(due, 1);
  const refresh = run.queued.filter(([kind]) => kind === "refresh");
  assert.equal(refresh.length, 1);
  assert.equal(refresh[0][1], OWNER);
  assert.equal(refresh[0][2], view.connectionId);
  assert.equal(refresh[0][3], 1);

  // The device code is single-use: a repeat poll never calls GitHub again or creates a second connection.
  const before = run.bodies.length;
  assert.deepEqual(await device.pollGithubDevice(database, flow.id, run.dependencies), { done: true });
  assert.equal(run.bodies.length, before);
  assert.equal((await adminPool.query("select count(*)::int as n from public.connections")).rows[0].n, 1);
});

test("refresh rotates both tokens; a rejected refresh token marks the connection expired and stops injection", { skip }, async () => {
  await flush();
  const success = deps({ answer: () => ({ access_token: ACCESS, token_type: "bearer", scope: "", refresh_token: REFRESH, expires_in: 28_800, refresh_token_expires_in: 15_552_000 }) });
  const flow = await device.startGithubDevice(database, OWNER, { agentId: AGENT }, success.dependencies);
  await device.pollGithubDevice(database, flow.id, success.dependencies);
  const view = await device.getGithubDeviceFlow(database, OWNER, flow.id);

  const rotate = deps({ answer: () => ({ access_token: NEW_ACCESS, token_type: "bearer", scope: "", refresh_token: NEW_REFRESH, expires_in: 28_800, refresh_token_expires_in: 15_552_000 }) });
  assert.deepEqual(await device.refreshGithubConnection(database, OWNER, view.connectionId, rotate.dependencies), { done: true });
  const rotated = await data.getConnection(database, OWNER, view.connectionId);
  assert.equal(JSON.stringify(rotated).includes(REFRESH), false, "the stored row keeps ciphertext only");
  assert.equal(rotate.bodies[0].operation, "token");
  assert.equal(rotate.bodies[0].refreshToken, REFRESH);
  assert.equal(rotated.tokenHint, "ghu_…cdef");
  const { decryptSecret } = await import("../lib/security/encryption.ts");
  assert.equal(decryptSecret(rotated.encryptedToken), NEW_ACCESS);
  assert.equal(decryptSecret(rotated.encryptedRefreshToken), NEW_REFRESH);
  assert.equal(rotate.queued.some(([kind]) => kind === "refresh"), false, "the tick schedules the next refresh");

  const rejected = deps({ answer: () => ({ error: "bad_refresh_token", error_description: "revoked" }) });
  assert.deepEqual(await device.refreshGithubConnection(database, OWNER, view.connectionId, rejected.dependencies), { done: true });
  const expired = await data.getConnection(database, OWNER, view.connectionId);
  assert.equal(expired.status, "expired");
  assert.equal(expired.encryptedRefreshToken, null);
  assert.equal((await device.refreshGithubConnection(database, OWNER, view.connectionId, rejected.dependencies)).done, true);

  const network = deps({ answer: () => { throw new Error("network"); } });
  const retry = await device.refreshGithubConnection(database, OWNER, view.connectionId, {
    ...network.dependencies, fetchImpl: async () => { throw new Error("network"); },
  });
  assert.deepEqual(retry, { done: true }, "an expired row is not refreshed again");
});

test("a transient network failure asks the queue to retry and keeps the token", { skip }, async () => {
  await flush();
  const success = deps({ answer: () => ({ access_token: ACCESS, token_type: "bearer", scope: "", refresh_token: REFRESH, expires_in: 28_800, refresh_token_expires_in: 15_552_000 }) });
  const flow = await device.startGithubDevice(database, OWNER, { agentId: AGENT }, success.dependencies);
  await device.pollGithubDevice(database, flow.id, success.dependencies);
  const view = await device.getGithubDeviceFlow(database, OWNER, flow.id);
  const failing = deps();
  failing.dependencies.fetchImpl = async () => { throw new Error("down"); };
  assert.deepEqual(await device.refreshGithubConnection(database, OWNER, view.connectionId, failing.dependencies), { retry: true });
  assert.equal((await data.getConnection(database, OWNER, view.connectionId)).status, "active");
});
