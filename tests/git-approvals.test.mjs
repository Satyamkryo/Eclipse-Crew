import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import net from "node:net";

import {
  createRegistry, egressToken, MAX_GRANTS, MAX_GRANTS_PER_AGENT, MAX_PENDING, MAX_PENDING_PER_AGENT,
} from "../docker/egress/registry.mjs";
import { createGitGateway, requestHashFor } from "../docker/egress/git-gateway.mjs";
import { createProxy } from "../docker/egress/proxy.mjs";
import { createCredentialStore } from "../docker/egress/credentials.mjs";
import {
  clearPushApprovals, denyPush, fetchPushPending, grantPush, revokePushGrants,
} from "../lib/egress/sync.ts";
import { createShellPort } from "../lib/agent/shell-port.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "11111111-1111-4111-8111-111111111111";
const SECRET = "ab".repeat(32);
const TOKEN = "ghp_synthetic_push_grant_token_1234567890";
const OLD = "a".repeat(40); const NEW = "b".repeat(40); const NEW2 = "c".repeat(40); const ZERO = "0".repeat(40);
const pkt = (text) => { const body = Buffer.from(text); return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0")), body]); };
const flush = Buffer.from("0000");
const preface = (agent = A) => `ECLIPSE-AGENT ${agent} ${egressToken(SECRET, agent)}\n`;

const mainCommand = { old: OLD, new: NEW, ref: "refs/heads/main" };
const deleteCommand = { old: OLD, new: ZERO, ref: "refs/heads/stale" };
const mainBlocked = { kind: "default_branch", class: "post", ref: mainCommand.ref, name: "main", old: OLD, new: NEW };
const deleteBlocked = { kind: "delete", class: "delete", ref: deleteCommand.ref, name: "stale", old: OLD, new: ZERO };

function makeRegistry({ pendingTtlMs, grantTtlMs, ttlMs, now } = {}) {
  return createRegistry({ now, ttlMs, pendingTtlMs, grantTtlMs });
}
function queue(registry, commands, blocked, agentId = A) {
  return registry.createPending({
    agentId, owner: "Owner", repo: "Repo", requestHash: requestHashFor(commands), commands, blocked,
  });
}
function requiredOf(commands, blocked) {
  return blocked.map((item) => {
    const command = commands.find((value) => value.ref === item.ref);
    return { ref: item.ref, kind: item.kind, old: command.old, new: command.new };
  });
}
function consume(registry, requestHash, required, agentId = A) {
  return registry.consumeGrants({ agentId, owner: "owner", repo: "repo", requestHash, required });
}

test("registry: pending is deduplicated and capped; grants are exact, single-use and idempotent", () => {
  const registry = makeRegistry();
  registry.setPolicy(A, ["github.com"], false);
  const commands = [mainCommand, deleteCommand];
  const blocked = [mainBlocked, deleteBlocked];
  const hash = requestHashFor(commands);

  const first = queue(registry, commands, blocked);
  assert.equal(first.ok, true);
  assert.equal(first.pending.length, 2);
  assert.equal(first.pending[0].site, "github.com/owner/repo");
  assert.equal(first.pending[0].controlName, "push to main on owner/repo");
  assert.equal(first.pending[1].controlName, "delete branch stale on owner/repo");
  assert.deepEqual([first.pending[0].actionClass, first.pending[1].actionClass], ["post", "delete"]);

  const duplicate = queue(registry, commands, blocked);
  assert.deepEqual(duplicate.pending.map((item) => item.id), first.pending.map((item) => item.id));
  assert.deepEqual(duplicate.pending.map((item) => item.expiresAt), first.pending.map((item) => item.expiresAt), "dedupe never extends the TTL");
  assert.equal(registry.listPending(A).length, 2);

  const firstGrant = registry.grantPending(A, first.pending[0].id);
  assert.equal(firstGrant.ok, true);
  assert.equal(registry.listPending(A).length, 1, "granting removes the pending from the queue");
  const partialQueue = queue(registry, commands, blocked);
  assert.deepEqual(partialQueue.pending.map((item) => item.id), first.pending.map((item) => item.id), "a retry reuses the group ids");
  assert.deepEqual(registry.listPending(A).map((item) => item.ref), [deleteCommand.ref], "only the missing ref is still queued");
  const repeated = registry.grantPending(A, first.pending[0].id);
  assert.equal(repeated.ok, true);
  assert.equal(repeated.grant.id, firstGrant.grant.id, "a repeated grant returns the same unused grant");
  assert.equal(repeated.grant.expiresAt, firstGrant.grant.expiresAt, "and does not renew it");

  assert.equal(registry.grantPending(B, first.pending[1].id).ok, false, "another agent cannot grant this pending");
  const required = requiredOf(commands, blocked);
  assert.equal(consume(registry, hash, required).ok, false, "one missing grant consumes none");
  assert.equal(registry.grantPending(A, first.pending[0].id).grant.id, firstGrant.grant.id, "the first grant survived the partial attempt");
  const wrongOld = required.map((item, index) => index === 0 ? { ...item, old: NEW2 } : item);
  assert.equal(consume(registry, hash, wrongOld).ok, false, "a changed old object id needs fresh approval");
  assert.equal(consume(registry, "f".repeat(64), required).ok, false, "a changed request hash needs fresh approval");

  const secondGrant = registry.grantPending(A, first.pending[1].id);
  assert.equal(secondGrant.ok, true);
  assert.equal(registry.listPending(A).length, 0);
  assert.deepEqual(consume(registry, hash, required), { ok: true, consumed: 2 });
  assert.equal(consume(registry, hash, required).ok, false, "a consumed grant cannot authorize a second attempt");
  assert.equal(registry.grantPending(A, first.pending[0].id).error, "already_consumed", "a consumed id cannot mint again");
});

test("registry: pending and grant TTLs, policy expiry and both caps fail closed", () => {
  let at = 1_000_000;
  const registry = makeRegistry({ now: () => at, ttlMs: 1_000, pendingTtlMs: 500, grantTtlMs: 300 });
  registry.setPolicy(A, ["github.com"], false);
  const one = queue(registry, [mainCommand], [mainBlocked]);
  at += 501;
  assert.equal(registry.listPending(A).length, 0, "a pending expires after its TTL");
  assert.equal(registry.grantPending(A, one.pending[0].id).ok, false, "an expired pending cannot be granted");

  at = 2_000_000;
  registry.setPolicy(A, ["github.com"], false);
  const two = queue(registry, [mainCommand], [mainBlocked]);
  assert.equal(registry.grantPending(A, two.pending[0].id).ok, true);
  at += 301;
  assert.equal(consume(registry, requestHashFor([mainCommand]), requiredOf([mainCommand], [mainBlocked])).ok, false, "a grant expires after its TTL");
  assert.equal(registry.grantPending(A, two.pending[0].id).error, "expired");

  at = 3_000_000;
  registry.setPolicy(A, ["github.com"], false);
  queue(registry, [mainCommand], [mainBlocked]);
  at += 1_001;
  assert.equal(registry.listPending(A).length, 0, "policy expiry invalidates this agent's pending records");

  at = 4_000_000;
  registry.setPolicy(A, ["github.com"], false);
  for (let index = 0; index < MAX_PENDING_PER_AGENT; index += 1) {
    const command = { old: OLD, new: NEW, ref: `refs/heads/b${index}` };
    assert.equal(queue(registry, [command], [{ kind: "default_branch", class: "post", ref: command.ref, name: command.ref.slice(11) }]).ok, true);
  }
  const overPending = { old: OLD, new: NEW, ref: "refs/heads/over" };
  assert.deepEqual(queue(registry, [overPending], [{ kind: "default_branch", class: "post", ref: overPending.ref, name: "over" }]),
    { ok: false, error: "pending_limit" });
  assert.equal(registry.listPending(A).length, MAX_PENDING_PER_AGENT, "a capped request inserts nothing");

  for (const item of registry.listPending(A)) assert.equal(registry.grantPending(A, item.id).ok, true);
  const extra = { old: OLD, new: NEW, ref: "refs/heads/extra" };
  assert.equal(queue(registry, [extra], [{ kind: "default_branch", class: "post", ref: extra.ref, name: "extra" }]).ok, true);
  assert.equal(registry.listPending(A)[0].ref, extra.ref);
  assert.deepEqual(registry.grantPending(A, registry.listPending(A)[0].id), { ok: false, error: "grant_limit" }, `cap is ${MAX_GRANTS_PER_AGENT} unused grants per agent`);
});

test("registry: the global pending and grant caps fail closed and a restart clears everything", () => {
  const registry = makeRegistry();
  const agentId = (index) => `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const queued = [];
  for (let agent = 1; agent <= MAX_PENDING / MAX_PENDING_PER_AGENT; agent += 1) {
    const id = agentId(agent);
    registry.setPolicy(id, ["github.com"], false);
    for (let index = 0; index < MAX_PENDING_PER_AGENT; index += 1) {
      const command = { old: OLD, new: NEW, ref: `refs/heads/g${agent}-${index}` };
      const result = queue(registry, [command], [{ kind: "default_branch", class: "post", ref: command.ref, name: command.ref.slice(11) }], id);
      assert.equal(result.ok, true);
      queued.push({ agent: id, id: result.pending[0].id });
    }
  }
  assert.equal(registry.stats().pending, MAX_PENDING);
  const overflow = agentId(MAX_PENDING / MAX_PENDING_PER_AGENT + 1);
  registry.setPolicy(overflow, ["github.com"], false);
  const over = { old: OLD, new: NEW, ref: "refs/heads/over" };
  assert.deepEqual(queue(registry, [over], [{ kind: "default_branch", class: "post", ref: over.ref, name: "over" }], overflow),
    { ok: false, error: "pending_limit" });

  for (const item of queued) assert.equal(registry.grantPending(item.agent, item.id).ok, true);
  assert.equal(registry.stats().grants, MAX_GRANTS);
  const extra = queue(registry, [over], [{ kind: "default_branch", class: "post", ref: over.ref, name: "over" }], overflow);
  assert.equal(extra.ok, true);
  assert.deepEqual(registry.grantPending(overflow, extra.pending[0].id), { ok: false, error: "grant_limit" });

  registry.closeAll();
  assert.equal(registry.listPending(overflow).length, 0);
  assert.equal(registry.stats().pending, 0);
  assert.equal(registry.stats().grants, 0);
});

test("registry: deny, revoke, clear and trip invalidate the right records", () => {
  const registry = makeRegistry();
  registry.setPolicy(A, ["github.com"], false);
  const commands = [mainCommand, deleteCommand];
  const blocked = [mainBlocked, deleteBlocked];
  const hash = requestHashFor(commands);
  const first = queue(registry, commands, blocked);
  assert.equal(registry.grantPending(A, first.pending[0].id).ok, true);
  assert.equal(registry.denyPending(A, first.pending[1].id), true, "denying one ref clears the request group");
  assert.equal(registry.listPending(A).length, 0);
  assert.equal(consume(registry, hash, requiredOf(commands, blocked)).ok, false, "the group's unused grant was cleared too");

  const second = queue(registry, [mainCommand], [mainBlocked]);
  assert.equal(registry.grantPending(A, second.pending[0].id).ok, true);
  assert.equal(registry.revokeGrants(A, "github.com/owner/repo", "post"), 1);
  assert.equal(consume(registry, requestHashFor([mainCommand]), requiredOf([mainCommand], [mainBlocked])).ok, false);

  const third = queue(registry, [mainCommand], [mainBlocked]);
  assert.equal(registry.grantPending(A, third.pending[0].id).ok, true);
  registry.trip(A);
  assert.equal(registry.listPending(A).length, 0);
  assert.equal(consume(registry, requestHashFor([mainCommand]), requiredOf([mainCommand], [mainBlocked])).ok, false);

  registry.setPolicy(A, ["github.com"], false);
  queue(registry, [mainCommand], [mainBlocked]);
  assert.equal(registry.clearAgent(A), true);
  assert.equal(registry.listPending(A).length, 0);
});

function fakeUpstream(record) {
  return (options, onResponse) => {
    record.options.push(options);
    const request = new EventEmitter();
    request.write = (chunk) => { record.body.push(Buffer.from(chunk)); };
    request.destroy = () => {};
    request.end = () => {
      record.ended = true;
      const response = new EventEmitter();
      response.statusCode = 200; response.statusMessage = "OK";
      response.headers = { "content-type": "application/x-git-receive-pack-result" };
      onResponse(response);
      setImmediate(() => { response.emit("data", Buffer.from("upstream-ok")); response.emit("end"); });
    };
    return request;
  };
}
function request(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }); const chunks = [];
    socket.setTimeout(5000, () => { socket.destroy(); reject(Error("timeout")); });
    socket.once("connect", () => socket.write(text));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
  });
}
const status = (response) => +/^HTTP\/1\.1 (\d{3})/.exec(response)?.[1];
function receive(port, commands, agentId = A) {
  const body = Buffer.concat([pkt(`${commands[0].old} ${commands[0].new} ${commands[0].ref}\0report-status\n`), ...commands.slice(1).map((command) => pkt(`${command.old} ${command.new} ${command.ref}\n`)), flush]);
  return request(port, `${preface(agentId)}POST /git/github.com/owner/repo.git/git-receive-pack HTTP/1.1\r\nHost: 127.0.0.1:3129\r\nContent-Type: application/x-git-receive-pack-request\r\nContent-Length: ${body.length}\r\n\r\n${body.toString("latin1")}`);
}

async function gatewayFixture() {
  const registry = makeRegistry();
  registry.setPolicy(A, ["github.com"], false);
  const credentials = createCredentialStore();
  credentials.set(A, [{ host: "github.com", scheme: "basic", username: "x-access-token", token: TOKEN }]);
  const record = { options: [], body: [], ended: false }; const logs = [];
  const gateway = createGitGateway({ desktopSecret: SECRET, registry, credentials, upstream: fakeUpstream(record),
    resolve: async () => [{ address: "140.82.121.4", family: 4 }], lookupDefaultBranch: async () => "main", log: (event) => logs.push(event) });
  const address = await gateway.listen(0, "127.0.0.1");
  return { registry, credentials, record, logs, gateway, port: address.port };
}

test("gateway: a protected push queues one pending per ref; the exact retry consumes every grant", async () => {
  const fixture = await gatewayFixture();
  try {
    const commands = [mainCommand, deleteCommand];
    const blocked = await receive(fixture.port, commands);
    assert.equal(status(blocked), 403);
    assert.equal(fixture.record.options.length, 0, "no receive-pack request reaches GitHub");
    const pending = fixture.registry.listPending(A);
    assert.equal(pending.length, 2);
    assert.equal(pending[0].requestHash, requestHashFor(commands));
    assert.equal(pending[1].requestHash, requestHashFor(commands));
    for (const item of pending) assert.equal(fixture.registry.grantPending(A, item.id).ok, true);

    const allowed = await receive(fixture.port, commands);
    assert.equal(status(allowed), 200);
    assert.equal(fixture.record.options.length, 1, "one forwarding attempt");
    assert.equal(fixture.registry.listPending(A).length, 0);
    assert.equal(fixture.logs.some((event) => event.event === "git_push_allowed"), true);
    assert.equal(JSON.stringify(fixture.logs).includes(TOKEN), false);

    const again = await receive(fixture.port, commands);
    assert.equal(status(again), 403, "the consumed grants cannot authorize a second attempt");
    assert.equal(fixture.registry.listPending(A).length, 2, "a new attempt queues fresh approvals");
  } finally { await fixture.gateway.close(); }
});

test("gateway: changed object ids need fresh approval but the exact reviewed request still forwards", async () => {
  const fixture = await gatewayFixture();
  try {
    const commands = [mainCommand];
    assert.equal(status(await receive(fixture.port, commands)), 403);
    const pending = fixture.registry.listPending(A)[0];
    assert.equal(fixture.registry.grantPending(A, pending.id).ok, true);
    const changed = [{ ...mainCommand, new: NEW2 }];
    assert.equal(status(await receive(fixture.port, changed)), 403);
    assert.equal(fixture.record.options.length, 0, "a changed object id does not use the grant");
    assert.equal(status(await receive(fixture.port, commands)), 200, "the exact reviewed request still forwards");
    assert.equal(fixture.record.options.length, 1);
  } finally { await fixture.gateway.close(); }
});

test("gateway: an unprotected ref change is a different request and needs fresh approval", async () => {
  const fixture = await gatewayFixture();
  try {
    const mixed = [mainCommand, { old: ZERO, new: NEW, ref: "refs/heads/fix-1" }];
    assert.equal(status(await receive(fixture.port, mixed)), 403);
    const granted = fixture.registry.listPending(A).find((item) => item.ref === "refs/heads/main");
    assert.equal(fixture.registry.grantPending(A, granted.id).ok, true);
    const changedMixed = [mainCommand, { old: ZERO, new: NEW2, ref: "refs/heads/fix-1" }];
    assert.equal(status(await receive(fixture.port, changedMixed)), 403, "the same protected ref with a changed command list needs a new grant");
    assert.equal(fixture.record.options.length, 0);
    assert.equal(status(await receive(fixture.port, mixed)), 200, "the exact reviewed request still forwards");
    assert.equal(fixture.record.options.length, 1);
  } finally { await fixture.gateway.close(); }
});

test("gateway: two concurrent retries cannot both consume the same grant", async () => {
  const fixture = await gatewayFixture();
  try {
    const commands = [mainCommand];
    assert.equal(status(await receive(fixture.port, commands)), 403);
    const pending = fixture.registry.listPending(A)[0];
    assert.equal(fixture.registry.grantPending(A, pending.id).ok, true);
    const outcomes = await Promise.all([receive(fixture.port, commands), receive(fixture.port, commands)]);
    assert.deepEqual(outcomes.map(status).sort(), [200, 403]);
    assert.equal(fixture.record.options.length, 1, "only one attempt forwarded");
  } finally { await fixture.gateway.close(); }
});

test("gateway: requestHashFor is deterministic, order-independent and covers unprotected refs", () => {
  const one = requestHashFor([{ old: OLD, new: NEW, ref: "refs/heads/a" }, { old: ZERO, new: NEW, ref: "refs/heads/b" }]);
  const two = requestHashFor([{ old: ZERO, new: NEW, ref: "refs/heads/b" }, { old: OLD, new: NEW, ref: "refs/heads/a" }]);
  assert.equal(one, two);
  assert.notEqual(one, requestHashFor([{ old: OLD, new: NEW, ref: "refs/heads/a" }, { old: ZERO, new: NEW2, ref: "refs/heads/b" }]));
});

async function withProxy(registry, fn) {
  const server = createProxy({ secret: SECRET, registry });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); }
  finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); }
}
const auth = { Authorization: `Bearer ${SECRET}` };

test("proxy controls: Bearer only, bounded validation and cross-agent pending ids refused", async () => {
  const registry = makeRegistry();
  registry.setPolicy(A, ["github.com"], false);
  const pending = queue(registry, [mainCommand], [mainBlocked]).pending[0];
  await withProxy(registry, async (base) => {
    assert.equal((await fetch(`${base}/v1/pending?agentId=${A}`)).status, 401);
    assert.equal((await fetch(`${base}/v1/pending?agentId=${A}`, { headers: { Authorization: "Bearer " + "cd".repeat(32) } })).status, 401);

    const list = await fetch(`${base}/v1/pending?agentId=${A}`, { headers: auth });
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json()).pending.map((item) => item.id), [pending.id]);
    assert.equal((await fetch(`${base}/v1/pending?agentId=${A}&extra=1`, { headers: auth })).status, 400);
    assert.equal((await fetch(`${base}/v1/pending?agentId=${B}`, { headers: auth })).status, 200);

    const cross = await fetch(`${base}/v1/grants`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: B, pendingId: pending.id }) });
    assert.equal(cross.status, 404);
    const invalid = await fetch(`${base}/v1/grants`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: A, pendingId: pending.id, extra: true }) });
    assert.equal(invalid.status, 400);
    const granted = await fetch(`${base}/v1/grants`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: A, pendingId: pending.id }) });
    assert.equal(granted.status, 200);
    const grant = (await granted.json()).grant;
    const repeated = await fetch(`${base}/v1/grants`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: A, pendingId: pending.id }) });
    assert.equal((await repeated.json()).grant.id, grant.id);
    assert.equal(registry.listPending(A).length, 0);

    assert.equal(registry.consumeGrants({ agentId: A, owner: "owner", repo: "repo", requestHash: requestHashFor([mainCommand]),
      required: requiredOf([mainCommand], [mainBlocked]) }).ok, true);
    const consumed = await fetch(`${base}/v1/grants`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: A, pendingId: pending.id }) });
    assert.equal(consumed.status, 409);
    assert.equal((await consumed.json()).error, "already_consumed");
  });
});

test("proxy controls: clearing a request group, revoking grants and clearing an agent", async () => {
  const registry = makeRegistry();
  registry.setPolicy(A, ["github.com"], false);
  const first = queue(registry, [mainCommand], [mainBlocked]).pending[0];
  await withProxy(registry, async (base) => {
    assert.equal((await fetch(`${base}/v1/pending/${first.id}?agentId=${A}`, { method: "DELETE", headers: auth })).status, 200);
    assert.equal(registry.listPending(A).length, 0);

    const second = queue(registry, [mainCommand], [mainBlocked]).pending[0];
    assert.equal(registry.grantPending(A, second.id).ok, true);
    const revoked = await fetch(`${base}/v1/grants?agentId=${A}&site=${encodeURIComponent("github.com/owner/repo")}&actionClass=post`,
      { method: "DELETE", headers: auth });
    assert.equal(revoked.status, 200);
    assert.equal((await revoked.json()).revoked, 1);
    assert.equal(consume(registry, requestHashFor([mainCommand]), requiredOf([mainCommand], [mainBlocked])).ok, false);

    queue(registry, [mainCommand], [mainBlocked]);
    assert.equal((await fetch(`${base}/v1/git-approvals?agentId=${A}`, { method: "DELETE", headers: auth })).status, 200);
    assert.equal(registry.listPending(A).length, 0);

    assert.equal((await fetch(`${base}/v1/grants?agentId=${A}&site=bad&actionClass=post`, { method: "DELETE", headers: auth })).status, 400);
    assert.equal((await fetch(`${base}/v1/git-approvals?agentId=nope`, { method: "DELETE", headers: auth })).status, 400);
  });
});

test("app controls: pending, grant, deny, clear and revoke use the proxy secret and bound every result", async () => {
  const calls = [];
  const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes("/v1/pending")) return respond({ pending: [{
      id: A, site: "github.com/owner/repo", actionClass: "post", controlName: "push to main on owner/repo",
      ref: "refs/heads/main", kind: "default_branch", owner: "owner", repo: "repo", requestHash: "a".repeat(64),
      expiresAt: new Date().toISOString(),
    }] });
    if (url.includes("/v1/grants") && init.method === "POST") return respond({ grant: { id: B, expiresAt: new Date().toISOString() } });
    return respond({ ok: true });
  };
  const options = { secret: SECRET, baseUrl: "http://proxy.test:4320", fetchImpl, timeoutMs: 1_000 };
  const pending = await fetchPushPending(A, options);
  assert.equal(pending.length, 1);
  assert.equal(calls[0].url, `http://proxy.test:4320/v1/pending?agentId=${A}`);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${SECRET}`);
  assert.ok(calls[0].init.signal instanceof AbortSignal);

  assert.equal(await grantPush(A, A, options), true);
  assert.deepEqual(JSON.parse(calls[1].init.body), { agentId: A, pendingId: A });
  assert.equal(calls[1].init.headers["Content-Type"], "application/json");
  assert.equal(await denyPush(A, A, options), true);
  assert.equal(calls[2].url, `http://proxy.test:4320/v1/pending/${A}?agentId=${A}`);
  assert.equal(calls[2].init.method, "DELETE");
  assert.equal(await clearPushApprovals(A, options), true);
  assert.equal(calls[3].url, `http://proxy.test:4320/v1/git-approvals?agentId=${A}`);
  assert.equal(await revokePushGrants(A, "github.com/owner/repo", "post", options), true);
  assert.match(calls[4].url, /\/v1\/grants\?agentId=.*&site=github\.com%2Fowner%2Frepo&actionClass=post$/);

  assert.equal(await fetchPushPending(A, { ...options, fetchImpl: async () => respond({ pending: [{ id: "bad" }] }) }), null);
  assert.equal(await grantPush(A, A, { ...options, fetchImpl: async () => respond({ error: "x" }, 409) }), false);
  assert.equal(await fetchPushPending(A, { ...options, secret: "short" }), null);
  assert.equal(await revokePushGrants(A, "bad site", "post", options), false);
  assert.equal(await fetchPushPending("not-a-uuid", options), null);
  assert.equal(JSON.stringify(calls).includes(TOKEN), false);
});

test("shell port: push controls are bound to the agent and fail closed", async () => {
  const pending = {
    id: B, site: "github.com/owner/repo", actionClass: "post", controlName: "push to main on owner/repo",
    ref: "refs/heads/main", kind: "default_branch", owner: "owner", repo: "repo", requestHash: "a".repeat(64), expiresAt: new Date().toISOString(),
  };
  const seen = [];
  const port = createShellPort({
    agentId: A, ownerId: OWNER, generation: OWNER,
    pendingCall: async (agentId) => { seen.push(["pending", agentId]); return [pending]; },
    grantCall: async (agentId, id) => { seen.push(["grant", agentId, id]); return true; },
    denyCall: async (agentId, id) => { seen.push(["deny", agentId, id]); return true; },
    clearCall: async (agentId) => { seen.push(["clear", agentId]); return true; },
  });
  assert.deepEqual(await port.pending(), [pending]);
  await port.grant(pending.id);
  await port.deny(pending.id);
  await port.clearApprovals();
  assert.deepEqual(seen, [["pending", A], ["grant", A, pending.id], ["deny", A, pending.id], ["clear", A]]);

  const failed = createShellPort({
    agentId: A, ownerId: OWNER, generation: OWNER,
    pendingCall: async () => null,
    grantCall: async () => false,
    denyCall: async () => false,
    clearCall: async () => false,
  });
  await assert.rejects(failed.pending(), (error) => error.code === "approval_unavailable");
  await assert.rejects(failed.grant(pending.id), (error) => error.code === "approval_unavailable");
  await assert.rejects(failed.deny(pending.id), (error) => error.code === "approval_unavailable");
  await assert.rejects(failed.clearApprovals(), (error) => error.code === "approval_unavailable");
});
