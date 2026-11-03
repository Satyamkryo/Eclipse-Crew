import assert from "node:assert/strict";
import test from "node:test";
import { compactStep } from "../lib/receipts/history-view.ts";
import { loadLiveRun } from "../lib/runs/live.ts";
import { registerRun } from "../lib/jobs/control.ts";

const RUN = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const receipt = (idx, cost) => JSON.stringify({ idx, model: "muse-spark-1.3", model_label: "Main", route: "fixed",
  action: { kind: "click", target: "Save" }, target: { role: "button", name: "Save" }, grounding_method: "page_structure",
  methods: [{ phase: "verify", method: "page_structure", status: "pass", code: "control_present" }], sam: "off",
  confidence: "medium", before_hash: null, after_hash: null, postcondition: "control_present: Saved", result: "pass",
  code: null, executed: true, usage: { input: 1, output: 1, cached: 0, reasoning: 0 }, cost_micro_usd: cost });
const step = (idx, cost) => ({ idx, receiptJson: receipt(idx, cost), receiptHash: "a".repeat(64), prevHash: "b".repeat(64) });
function databaseFor(runs, steps) {
  let calls = 0;
  return { select() {
    const value = calls++ === 0 ? runs : steps;
    const chain = { from() { return chain; }, where() { return chain; }, orderBy() { return chain; }, limit() { return Promise.resolve(value); },
      then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } };
    return chain;
  } };
}

test("compact steps keep only the visible progress fields", () => {
  const view = { idx: 3, action: "Click", target: "Save", result: "pass", tone: "success", confidence: "medium", method: "m",
    sam: "off", model: "muse-spark-1.3", postcondition: "x", code: null, costMicroUsd: 12, receiptHash: "a", prevHash: "b",
    beforeImage: null, afterImage: null, screens: "none", imageWidth: null, imageHeight: null, samBox: null,
    checkpoint: "missing", checkpointReason: null };
  assert.deepEqual(compactStep(view), { idx: 3, action: "Click", target: "Save", result: "pass", tone: "success",
    model: "muse-spark-1.3", costMicroUsd: 12 });
});

test("live run returns the newest active run's last compact steps, or null when idle/another owner", async () => {
  const started = new Date("2026-11-03T06:00:00.000Z");
  const db = databaseFor([{ id: RUN, startedAt: started }], [step(2, 20), step(1, 10)]);
  assert.equal(await loadLiveRun(db, OWNER, AGENT), null, "unregistered runs are not live");
  const control = registerRun(RUN, OWNER, AGENT);
  try {
    const live = await loadLiveRun(databaseFor([{ id: RUN, startedAt: started }], [step(2, 20), step(1, 10)]), OWNER, AGENT);
    assert.ok(live);
    assert.equal(live.runId, RUN);
    assert.equal(live.startedAt, started.toISOString());
    assert.deepEqual(live.steps.map((item) => item.idx), [1, 2]);
    assert.equal(live.costMicroUsd, 30);
    assert.equal(await loadLiveRun(databaseFor([{ id: RUN, startedAt: started }], [step(1, 10)]), "other-owner", AGENT), null);
  } finally { control.done(); }
  assert.equal(await loadLiveRun(databaseFor([{ id: RUN, startedAt: started }], [step(1, 10)]), OWNER, AGENT), null);
});
