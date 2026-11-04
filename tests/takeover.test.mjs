import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { SessionManager } from "../docker/desktop/session-manager.mjs";
import { OwnerInputSchema, TakeoverSchema } from "../docker/desktop/controller-schema.mjs";

function fixture() {
  const manager = new SessionManager();
  const ownerId = randomUUID(), agentId = randomUUID(), generation = randomUUID();
  const calls = [], events = [];
  const record = { ownerId, agentId, uid: 20001, gid: 20001, name: "synthetic", state: "ready" };
  const entry = { record, state: "running", graphics: "running", generation, vncReady: true, vncPort: 5951, vncPassword: "SyntheT+",
    channel: { async send(message) { calls.push(message); events.push("dispatch:" + message.operation); return { ok: true }; }, close() { events.push("channel:closed"); } }, tracked: new Map() };
  manager.entries.set(agentId, entry); manager.generations.set(agentId, generation);
  manager.clean = async () => { events.push("clean"); };
  const control = { generation, connectionId: randomUUID(), sessionRef: "a".repeat(64), requestId: randomUUID() };
  const unregister = manager.registerViewer(ownerId, agentId, control, () => events.push("viewer:closed"));
  return { manager, ownerId, agentId, generation, entry, calls, events, control, unregister };
}
const rejectsCode = (run, code) => assert.rejects(async () => run(), (error) => error.code === code);
const turn = () => new Promise(setImmediate);

test("page.verify retains owner, generation and takeover guards without worker dispatch", async () => {
  const f = fixture();
  const predicate = { kind: "control_present", value: "Save" };
  await rejectsCode(() => f.manager.executeOperation(randomUUID(), f.agentId, f.generation, randomUUID(), "page.verify", { predicate }), "agent_unavailable");
  await rejectsCode(() => f.manager.executeOperation(f.ownerId, f.agentId, randomUUID(), randomUUID(), "page.verify", { predicate }), "stale_generation");
  await f.manager.takeOver(f.ownerId, f.agentId, f.control);
  await rejectsCode(() => f.manager.executeOperation(f.ownerId, f.agentId, f.generation, randomUUID(), "page.verify", { predicate }), "takeover_active");
  assert.equal(f.calls.length, 0);
});

test("takeover/control schemas require complete session, generation and lease metadata and reject extras", () => {
  const { ownerId, agentId, control } = fixture();
  const base = { ownerId, agentId, ...control };
  assert.equal(TakeoverSchema.safeParse({ ...base, operation: "takeover" }).success, true);
  assert.equal(TakeoverSchema.safeParse({ ...base, operation: "handback", leaseId: randomUUID() }).success, true);
  assert.equal(OwnerInputSchema.safeParse({ ...base, leaseId: randomUUID(), operation: "input.type", text: "hello" }).success, true);
  assert.equal(OwnerInputSchema.safeParse({ ...base, leaseId: randomUUID(), operation: "input.type", text: "hello", ownerInput: true }).success, false);
  for (const key of ["generation", "sessionRef", "connectionId", "requestId"]) {
    const incomplete = { ...base, operation: "takeover" }; delete incomplete[key];
    assert.equal(TakeoverSchema.safeParse(incomplete).success, false, key);
  }
  assert.equal(TakeoverSchema.safeParse({ ...base, operation: "handback" }).success, false);
  assert.equal(OwnerInputSchema.safeParse({ ...base, leaseId: randomUUID(), operation: "capture.screenshot" }).success, false);
  assert.equal(OwnerInputSchema.safeParse({ ...base, leaseId: randomUUID(), operation: "input.type", text: "hello", arbitrary: true }).success, false);
});
test("wrong owner, stale generation and stopped/uncertain sessions cannot dispatch or acquire a stream", async () => {
  const f = fixture();
  for (const [ownerId, generation, code] of [[randomUUID(), f.generation, "agent_unavailable"], [f.ownerId, randomUUID(), "stale_generation"]]) {
    await rejectsCode(() => f.manager.executeOperation(ownerId, f.agentId, generation, randomUUID(), "input.click", { button: "left", x: 1, y: 2 }), code);
    assert.throws(() => f.manager.streamInfo(ownerId, f.agentId, { ...f.control, generation }), { code });
  }
  f.entry.state = "stopped";
  await rejectsCode(() => f.manager.takeOver(f.ownerId, f.agentId, f.control), "session_not_running");
  f.entry.state = "running"; f.entry.uncertain = true;
  await rejectsCode(() => f.manager.takeOver(f.ownerId, f.agentId, f.control), "uncertain_outcome");
  assert.equal(f.calls.length, 0);
});
test("dispatch rechecks owner and generation after queued work waits", async () => {
  for (const change of ["owner", "generation", "entry", "state"]) {
    const f = fixture(); let release;
    const blocked = f.manager.serialize(f.agentId, () => new Promise((resolve) => { release = resolve; }));
    await turn();
    const pending = f.manager.executeOperation(f.ownerId, f.agentId, f.generation, randomUUID(), "input.click", { button: "left", x: 1, y: 2 });
    const check = rejectsCode(() => pending, change === "owner" ? "agent_unavailable" : change === "state" ? "session_not_running" : "stale_generation");
    if (change === "owner") f.entry.record = { ...f.entry.record, ownerId: randomUUID() };
    if (change === "generation") f.entry.generation = randomUUID();
    if (change === "entry") f.manager.entries.set(f.agentId, { ...f.entry, generation: randomUUID() });
    if (change === "state") f.entry.state = "stopping";
    release(); await blocked; await check;
    assert.equal(f.calls.length, 0, change);
  }
});
test("takeover acknowledgment waits for active work then prevents a queued screenshot dispatch", async () => {
  const f = fixture(); let finishOperation;
  f.entry.channel.send = async (message) => { f.calls.push(message); return new Promise((resolve) => { finishOperation = resolve; }); };
  const active = f.manager.executeOperation(f.ownerId, f.agentId, f.generation, randomUUID(), "input.click", { button: "left", x: 10, y: 20 });
  await turn();
  let acknowledged = false;
  const takeover = f.manager.takeOver(f.ownerId, f.agentId, f.control).then((value) => { acknowledged = true; return value; });
  const capture = f.manager.executeOperation(f.ownerId, f.agentId, f.generation, randomUUID(), "capture.screenshot", {});
  const captureDenied = rejectsCode(() => capture, "takeover_active");
  await turn(); assert.equal(acknowledged, false);
  finishOperation({ ok: true }); await active;
  const lease = await takeover; await captureDenied;
  assert.equal(lease.takenOver, true); assert.equal(lease.generation, f.generation);
  assert.match(lease.leaseId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(f.calls.map((message) => message.operation), ["input.click"]);
  await rejectsCode(() => f.manager.executeOperation(f.ownerId, f.agentId, f.generation, randomUUID(), "input.type", { text: "blocked" }), "takeover_active");
});
test("owner input and handback are bound to the active owner/session/viewer/lease", async () => {
  const f = fixture();
  await rejectsCode(() => f.manager.ownerInput(f.ownerId, f.agentId, "input.type", { text: "hello" }, f.control), "not_in_takeover");
  const lease = await f.manager.takeOver(f.ownerId, f.agentId, f.control);
  const control = { ...f.control, leaseId: lease.leaseId, requestId: randomUUID() };
  for (const extra of [{ sessionRef: "b".repeat(64) }, { connectionId: randomUUID() }, { generation: randomUUID() }, { leaseId: randomUUID() }]) {
    await assert.rejects(async () => f.manager.ownerInput(f.ownerId, f.agentId, "input.type", { text: "hello" }, { ...control, ...extra }));
    await assert.rejects(async () => f.manager.handBack(f.ownerId, f.agentId, { ...control, ...extra }));
  }
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.manager.ownerInput(f.ownerId, f.agentId, "input.type", { text: "hello" }, control), { ok: true });
  assert.deepEqual(f.calls[0].params, { operation: "input.type", text: "hello" });
  assert.equal(f.calls[0].ownerInput, true);
  await rejectsCode(() => f.manager.ownerInput(f.ownerId, f.agentId, "capture.screenshot", {}, { ...control, requestId: randomUUID() }), "capture_blocked_during_takeover");
  assert.deepEqual(await f.manager.handBack(f.ownerId, f.agentId, control), { takenOver: false, generation: f.generation });
  assert.equal(f.manager.takeovers.has(f.agentId), false);
  assert.deepEqual(await f.manager.executeOperation(f.ownerId, f.agentId, f.generation, randomUUID(), "input.click", { x: 0, y: 0, button: "left" }), { ok: true });
  assert.equal(Object.hasOwn(f.calls[1], "ownerInput"), false);
});
test("disconnect releases only its own lease and queued input cannot act afterward", async () => {
  const f = fixture();
  const lease = await f.manager.takeOver(f.ownerId, f.agentId, f.control);
  let release;
  const blocked = f.manager.serialize(f.agentId, () => new Promise((resolve) => { release = resolve; })); await turn();
  const pending = f.manager.ownerInput(f.ownerId, f.agentId, "input.type", { text: "hello" }, { ...f.control, leaseId: lease.leaseId, requestId: randomUUID() });
  const check = rejectsCode(() => pending, "viewer_not_active");
  f.unregister(); assert.equal(f.manager.takeovers.has(f.agentId), false);
  release(); await blocked; await check;
  assert.equal(f.calls.length, 0);
});
test("second viewer cannot steal control and disconnecting it does not release the first lease", async () => {
  const f = fixture();
  const lease = await f.manager.takeOver(f.ownerId, f.agentId, f.control);
  const second = { ...f.control, connectionId: randomUUID() };
  const unregister = f.manager.registerViewer(f.ownerId, f.agentId, second, () => {});
  await rejectsCode(() => f.manager.takeOver(f.ownerId, f.agentId, second), "takeover_conflict");
  unregister(); assert.equal(f.manager.takeovers.get(f.agentId).leaseId, lease.leaseId);
  f.unregister(); assert.equal(f.manager.takeovers.has(f.agentId), false);
});
test("duplicate request IDs never redispatch, and replay cache and pending queue stay bounded", async () => {
  const f = fixture(), requestId = randomUUID();
  const command = () => f.manager.executeOperation(f.ownerId, f.agentId, f.generation, requestId, "input.click", { button: "left", x: 1, y: 1 });
  await command(); await rejectsCode(command, "duplicate_request_id"); assert.equal(f.calls.length, 1);
  for (let i = 0; i < 400; i++) f.manager.remember(f.agentId, randomUUID());
  assert.equal(f.manager.requestIds.get(f.agentId).size, 256);
  let release;
  const jobs = [f.manager.serialize(f.agentId, () => new Promise((resolve) => { release = resolve; }))]; await turn();
  for (let i = 1; i < 32; i++) jobs.push(f.manager.serialize(f.agentId, () => undefined));
  await rejectsCode(() => f.manager.serialize(f.agentId, () => undefined), "queue_full");
  release(); await Promise.all(jobs); await turn();
  assert.equal(f.manager.queued.size, 0); assert.equal(f.manager.queues.size, 0);
});
test("uncertain worker outcomes quarantine the session, close viewers and prohibit continuation", async () => {
  const f = fixture();
  f.entry.channel.send = async () => { throw Object.assign(Error("synthetic timeout"), { code: "uncertain_outcome" }); };
  await rejectsCode(() => f.manager.executeOperation(f.ownerId, f.agentId, f.generation, randomUUID(), "input.click", { button: "left", x: 1, y: 1 }), "uncertain_outcome");
  assert.equal(f.entry.uncertain, true); assert.equal(f.entry.state, "failed");
  assert.ok(f.events.includes("channel:closed")); assert.ok(f.events.includes("viewer:closed")); assert.ok(f.events.includes("clean"));
  await rejectsCode(() => f.manager.executeOperation(f.ownerId, f.agentId, f.generation, randomUUID(), "input.click", { button: "left", x: 1, y: 1 }), "session_not_running");
});
test("worker responses are checked against the requested operation before returning", async () => {
  const f = fixture(); f.entry.channel.send = async () => ({ arbitrary: true, secret: "SYNTHETIC_CANARY" });
  await rejectsCode(() => f.manager.executeOperation(f.ownerId, f.agentId, f.generation, randomUUID(), "input.click", { button: "left", x: 1, y: 1 }), "invalid_worker_result");
});

test("shutdown cancels a pending real session start before waiting for its lifecycle queue", () => {
  // Isolate the module adapter mock so the rest of this suite retains the real
  // implementation. No Linux process, registry or owner data is touched.
  const code = `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import { EventEmitter } from 'node:events';
    import { PassThrough } from 'node:stream';
    import { randomUUID } from 'node:crypto';
    const original = await import('./docker/desktop/agent-store.mjs');
    const ownerId = randomUUID(), agentId = randomUUID();
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), pid: 99999999, exitCode: null, signalCode: null });
    mock.module(new URL('./docker/desktop/agent-store.mjs', import.meta.url), {
      namedExports: { ...original,
        inspectAgent: async () => ({ ownerId, agentId, uid: 20000, gid: 20000, name: 'ec_20000', state: 'ready' }),
        launchAgent: () => child,
      },
    });
    const { SessionManager } = await import('./docker/desktop/session-manager.mjs');
    const manager = new SessionManager(); let cleaned = 0;
    manager.clean = async entry => { cleaned++; clearInterval(entry.monitor); child.exitCode = 0; child.stdout.end(); };
    const starting = manager.start(ownerId, agentId);
    const startResult = Promise.allSettled([starting]);
    await new Promise(setImmediate);
    assert.equal(manager.entries.get(agentId).state, 'starting');
    await Promise.race([manager.closeAll(), new Promise((_, reject) => setTimeout(() => reject(Error('shutdown_deadlock')), 1000))]);
    const [result] = await startResult;
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.code, 'supervisor_stopping');
    assert.ok(cleaned >= 1);
    assert.equal(manager.entries.get(agentId).state, 'stopped');
    await new Promise(setImmediate);
    assert.equal(manager.queues.size, 0);
    const quarantined = manager.entries.get(agentId);
    quarantined.state = 'failed'; quarantined.uncertain = true;
    assert.equal((await manager.stop(ownerId, agentId, quarantined.generation)).state, 'stopped');
    process.exit(0);
  `;
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "-e", code],
    { encoding: "utf8", timeout: 4000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
