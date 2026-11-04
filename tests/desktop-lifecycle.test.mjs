import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

import { CommandSchema, LIFECYCLE_OPERATIONS, SessionResultSchema } from "../docker/desktop/controller-schema.mjs";
import { SessionManager } from "../docker/desktop/session-manager.mjs";

const OWNER = randomUUID(), AGENT = randomUUID(), GENERATION = randomUUID();
const status = (patch = {}) => ({ agentId: AGENT, state: "running", sandbox: "running", graphics: "running", browser: "running", ...patch });

function entry(overrides = {}) {
  return {
    record: { ownerId: OWNER, agentId: AGENT, uid: 20000, gid: 20000, name: "ec_20000", state: "ready" },
    state: "running", sandbox: "running", graphics: "running", browser: "running", generation: GENERATION,
    tracked: new Map(), nsDir: "/run/eclipse-ns/agent", vncPort: 5950, vncPassword: "AbCdEf12", vncReady: true, vncSocket: "/run/eclipse-ns/agent/vnc.sock",
    ...overrides,
  };
}

test("closing Chromium stops only the browser; the sandbox, graphics and live desktop stay running", async () => {
  const manager = new SessionManager();
  const item = entry();
  await manager.handleWorkerEvent(item, { state: "browser_stopped" });
  assert.equal(item.state, "running");
  assert.equal(item.sandbox, "running");
  assert.equal(item.graphics, "running");
  assert.equal(item.browser, "stopped");
  assert.equal(item.vncReady, true);
  assert.equal(manager.state(item).graphics, "running");
  assert.equal(manager.state(item).browser, "stopped");
});

test("an explicit browser.start restores the stopped browser on the same sandbox and generation", async () => {
  const manager = new SessionManager();
  const item = entry({ browser: "stopped" });
  const calls = [];
  item.channel = { send: async (message) => { calls.push(message); return status(); } };
  const result = await manager.sendLifecycle(item, "browser.start", 1000);
  assert.equal(result.browser, "running");
  assert.equal(item.browser, "running");
  assert.equal(item.generation, GENERATION);
  assert.deepEqual(calls.map((call) => call.command), ["browser.start"]);
});

test("stopping graphics leaves the sandbox usable and clears the VNC stream state", async () => {
  const manager = new SessionManager();
  const item = entry();
  manager.clean = async () => {};
  await manager.handleWorkerEvent(item, { state: "desktop_stopped" });
  assert.equal(item.state, "running");
  assert.equal(item.sandbox, "running");
  assert.equal(item.graphics, "stopped");
  assert.equal(item.browser, "stopped");
  assert.equal(item.vncReady, false);
  assert.equal(item.vncPort, undefined);
});

test("a failed graphics component clears the VNC stream and refuses a new viewer", async () => {
  const manager = new SessionManager();
  const item = entry();
  manager.entries.set(AGENT, item);
  manager.clean = async () => {};
  await manager.handleWorkerEvent(item, { state: "desktop_failed", reason: "session_component_failed" });
  assert.equal(item.graphics, "failed");
  assert.equal(item.vncReady, false);
  assert.throws(() => manager.streamInfo(OWNER, AGENT, { generation: GENERATION }), (error) => error.code === "stream_unavailable");
});

test("only the sandbox worker ending fails the agent session", async () => {
  const manager = new SessionManager();
  const item = entry();
  manager.clean = async () => {};
  await manager.handleWorkerEvent(item, { state: "failed", reason: "session_component_failed" });
  assert.equal(item.state, "failed");
  assert.equal(item.sandbox, "failed");
});

test("lifecycle commands are strict and results expose independent states", () => {
  const base = { ownerId: OWNER, agentId: AGENT, requestId: randomUUID() };
  for (const operation of LIFECYCLE_OPERATIONS) {
    assert.equal(CommandSchema.parse({ ...base, operation }).operation, operation);
    assert.equal(CommandSchema.parse({ ...base, operation, generation: GENERATION }).operation, operation);
    assert.equal(CommandSchema.safeParse({ ...base, operation, executable: "/bin/sh" }).success, false);
    assert.equal(CommandSchema.safeParse({ ...base, operation, sessionRef: "b".repeat(64) }).success, false);
  }
  assert.equal(SessionResultSchema.safeParse(status()).success, true);
  assert.equal(SessionResultSchema.safeParse(status({ graphics: "oops" })).success, false);
  assert.equal(SessionResultSchema.safeParse({ ...status(), executable: "/bin/sh" }).success, false);
});

test("a malformed lifecycle result is refused instead of being applied", async () => {
  const manager = new SessionManager();
  const item = entry();
  item.channel = { send: async () => ({ ...status(), graphics: "oops" }) };
  await assert.rejects(manager.sendLifecycle(item, "desktop.start", 1000), (error) => error.code === "invalid_worker_result");
  assert.equal(item.graphics, "running");
});
