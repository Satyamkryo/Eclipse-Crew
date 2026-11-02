import assert from "node:assert/strict";
import test from "node:test";

import { hasWaiter, resolveDecision, waitForDecision } from "../lib/approvals/waiters.ts";

test("a waiting run receives exactly one owner decision", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const pending = waitForDecision(id, undefined, 5_000);
  assert.equal(hasWaiter(id), true);
  assert.equal(resolveDecision(id, "always_allow"), true);
  assert.equal(await pending, "always_allow");
  assert.equal(hasWaiter(id), false);
  assert.equal(resolveDecision(id, "deny"), false, "a lost race cannot change the answer");
});

test("owner cancellation aborts the wait without allowing the action", async () => {
  const id = "22222222-2222-4222-8222-222222222222";
  const controller = new AbortController();
  const pending = waitForDecision(id, controller.signal, 5_000);
  controller.abort();
  assert.equal(await pending, "aborted");
  assert.equal(hasWaiter(id), false);
});

test("an unanswered request times out", async () => {
  const id = "33333333-3333-4333-8333-333333333333";
  assert.equal(await waitForDecision(id, undefined, 5), "timeout");
  assert.equal(hasWaiter(id), false);
  assert.equal(resolveDecision(id, "allow_once"), false);
});
