import assert from "node:assert/strict";
import test from "node:test";

import { SECURITY_STOP_TEXT, clearTripwire, isTripped, triggerTripwire } from "../lib/security/tripwire.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const OTHER_OWNER = "33333333-3333-4333-8333-333333333333";

function ports(log, { recorded = true, stop = true, fail = null } = {}) {
  return {
    record: async () => { log.push("record"); return recorded; },
    latch: async () => { log.push("latch"); },
    cancelRuns: () => { log.push("cancel"); },
    stopSession: async () => { log.push("stop"); if (fail === "stop") throw new Error("stop"); return stop; },
    pause: async () => { log.push("pause"); if (fail === "pause") throw new Error("pause"); },
    postCard: async (_owner, _agent, _runId, stopped) => {
      log.push("card");
      log.push(stopped ? "stopped" : "not-stopped");
      if (fail === "card") throw new Error("card");
      return true;
    },
  };
}

const event = { ownerId: OWNER, agentId: AGENT, source: "typed_text", sourceRef: "typed_text:test:1" };

test("tripwire runs every effect once in the fixed order", async () => {
  clearTripwire(OWNER, AGENT);
  const log = [];
  const result = await triggerTripwire(ports(log), event);
  assert.deepEqual(log, ["record", "latch", "cancel", "stop", "pause", "card", "stopped"]);
  assert.deepEqual(result, { duplicate: false, cardPosted: true, sessionStopped: true });
  assert.equal(isTripped(OWNER, AGENT), true);
});

test("a second trigger for the same agent is a duplicate and changes nothing", async () => {
  clearTripwire(OWNER, AGENT);
  const log = [];
  await triggerTripwire(ports(log), event);
  const length = log.length;
  const result = await triggerTripwire(ports(log), { ...event, sourceRef: "typed_text:test:2" });
  assert.equal(result.duplicate, true);
  assert.equal(log.length, length);
});

test("a duplicate event row is a duplicate and does not trip", async () => {
  clearTripwire(OWNER, AGENT);
  const log = [];
  const result = await triggerTripwire(ports(log, { recorded: false }), event);
  assert.deepEqual(log, ["record"]);
  assert.equal(result.duplicate, true);
});

test("a failing session stop still pauses, cards, and says the desktop could not be stopped", async () => {
  clearTripwire(OWNER, AGENT);
  const log = [];
  const result = await triggerTripwire(ports(log, { fail: "stop" }), event);
  assert.deepEqual(log, ["record", "latch", "cancel", "stop", "pause", "card", "not-stopped"]);
  assert.equal(result.sessionStopped, false);
  assert.equal(SECURITY_STOP_TEXT.includes("canary"), true);
});

test("resume clears only that owner's agent", async () => {
  clearTripwire(OWNER, AGENT);
  const log = [];
  await triggerTripwire(ports(log), event);
  clearTripwire(OTHER_OWNER, AGENT);
  assert.equal(isTripped(OWNER, AGENT), true);
  clearTripwire(OWNER, AGENT);
  assert.equal(isTripped(OWNER, AGENT), false);
  const next = [];
  const result = await triggerTripwire(ports(next), { ...event, sourceRef: "typed_text:test:3" });
  assert.equal(result.duplicate, false);
});
