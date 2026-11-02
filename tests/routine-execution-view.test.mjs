import assert from "node:assert/strict";
import test from "node:test";

test("queue and run state collapse into the fixed Run Now display states", async () => {
  const { executionState } = await import("../lib/routines/execution-view.ts");
  assert.equal(executionState("created", false), "queued");
  assert.equal(executionState("retry", false), "retrying");
  assert.equal(executionState("active", false), "starting");
  assert.equal(executionState("active", true), "running");
  assert.equal(executionState("completed", true), "completed");
  assert.equal(executionState("completed", false), "failed");
  assert.equal(executionState("failed", false), "failed");
  assert.equal(executionState("cancelled", true), "failed");
  assert.equal(executionState(null, true), "completed");
  assert.equal(executionState(null, false), null);
});

test("the execution view exposes only a fixed state, retry count and signed run detail", async () => {
  const { executionView } = await import("../lib/routines/execution-view.ts");
  const detail = {
    run: { runId: "55555555-5555-4555-8555-555555555555", task: "Brief", startedAt: "2026-11-04T03:30:00.000Z",
      endedAt: null, durationMs: 1000, stepCount: 1, label: "Running", tone: "neutral", verified: false },
    agentId: "22222222-2222-4222-8222-222222222222", keyId: "key", chain: { state: "unsealed" },
    steps: [{ idx: 1, action: "Click", target: "Invoices", result: "pass", tone: "success", confidence: "high",
      method: "Page structure", sam: "off", model: "muse", postcondition: "invoices visible", code: null,
      costMicroUsd: 1200, receiptHash: "a".repeat(64), prevHash: "b".repeat(64), beforeImage: null, afterImage: null,
      screens: "none", imageWidth: null, imageHeight: null, samBox: null, checkpoint: "saved", checkpointReason: null }],
  };
  assert.deepEqual(executionView("44444444-4444-8444-8444-444444444444", { state: "active", retryCount: 1 }, detail), {
    executionId: "44444444-4444-8444-8444-444444444444",
    state: "running",
    retryCount: 1,
    runId: "55555555-5555-4555-8555-555555555555",
    detail,
  });
});
