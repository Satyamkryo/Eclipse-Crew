import assert from "node:assert/strict";
import test from "node:test";

import { MAX_HARD_TURNS, labelFor, pickRoute } from "../lib/agent/routing.ts";

const base = { main: "muse-spark-1.3-contributor", hard: "muse-wonder-1.0", hardDisabled: false, hardTurns: 0, repeats: 1 };

test("without a hard-step model every turn uses Main, whatever happened before", () => {
  for (const lastResult of [undefined, "executed", "invalid_output", "target_not_found", "failed"])
    for (const repeats of [0, 1, 2, 5])
      assert.deepEqual(pickRoute({ ...base, hard: null, lastResult, repeats }), { model: base.main, kind: "main" });
  assert.deepEqual(pickRoute({ ...base, hard: undefined, lastResult: "failed" }), { model: base.main, kind: "main" });
});

test("Auto uses Main until the previous turn failed or the same step repeated", () => {
  assert.equal(pickRoute({ ...base }).kind, "main");
  assert.equal(pickRoute({ ...base, lastResult: "executed" }).kind, "main");
  assert.equal(pickRoute({ ...base, lastResult: "executed", repeats: 1 }).kind, "main");
  for (const lastResult of ["invalid_output", "target_not_found", "failed"])
    assert.deepEqual(pickRoute({ ...base, lastResult }), { model: base.hard, kind: "hard" });
  assert.deepEqual(pickRoute({ ...base, lastResult: "executed", repeats: 2 }), { model: base.hard, kind: "hard" });
});

test("hard turns are capped and stop for good after a hard-model failure", () => {
  assert.equal(pickRoute({ ...base, lastResult: "failed", hardTurns: MAX_HARD_TURNS - 1 }).kind, "hard");
  assert.equal(pickRoute({ ...base, lastResult: "failed", hardTurns: MAX_HARD_TURNS }).kind, "main");
  assert.equal(pickRoute({ ...base, lastResult: "failed", hardDisabled: true }).kind, "main");
  assert.equal(MAX_HARD_TURNS, 5);
});

test("labels name the model family and keep Contributor visible", () => {
  assert.equal(labelFor("muse-spark-1.3"), "Muse Spark");
  assert.equal(labelFor("muse-spark-1.3-contributor"), "Muse Spark (Contributor)");
  assert.equal(labelFor("MUSE-SPARK-1.2-CONTRIBUTOR"), "Muse Spark (Contributor)");
  assert.equal(labelFor("muse-wonder-1.0"), "Muse Wonder");
  assert.equal(labelFor("gpt-5"), "gpt-5");
});
