import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("a confirmed routine renders a secondary Run Now button before any execution starts", async () => {
  const { RoutineRunNow } = await import("../components/chat/routine-run-now.tsx");
  const html = renderToStaticMarkup(React.createElement(RoutineRunNow, {
    routineId: "33333333-3333-4333-8333-333333333333",
    csrfToken: "csrf",
  }));
  assert.match(html, />Run now</);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /\sdisabled(?:=""|(?=[\s>]))/);
});

test("execution status text shows queue state, retry count, current step, elapsed time and cost", async () => {
  const { executionStatusText } = await import("../lib/routines/execution-view.ts");
  const executionId = "44444444-4444-8444-8444-444444444444";
  const now = new Date("2026-11-04T03:30:05.000Z");
  const detail = {
    run: { runId: "55555555-5555-4555-8555-555555555555", task: "Brief", startedAt: "2026-11-04T03:30:00.000Z",
      endedAt: null, durationMs: 5000, stepCount: 2, label: "Running", tone: "neutral", verified: false },
    agentId: "22222222-2222-4222-8222-222222222222", keyId: "key", chain: { state: "unsealed" },
    steps: [
      { idx: 1, action: "Click", target: "Invoices", result: "pass", tone: "success", confidence: "high",
        method: "Page structure", sam: "off", model: "muse", postcondition: "shown", code: null, costMicroUsd: 500,
        receiptHash: "a".repeat(64), prevHash: "b".repeat(64), beforeImage: null, afterImage: null, screens: "none",
        imageWidth: null, imageHeight: null, samBox: null, checkpoint: "saved", checkpointReason: null },
      { idx: 2, action: "Type 4 characters", target: null, result: "pass", tone: "success", confidence: "high",
        method: "Page structure", sam: "off", model: "muse", postcondition: "typed", code: null, costMicroUsd: 700,
        receiptHash: "c".repeat(64), prevHash: "a".repeat(64), beforeImage: null, afterImage: null, screens: "none",
        imageWidth: null, imageHeight: null, samBox: null, checkpoint: "saved", checkpointReason: null },
    ],
  };
  assert.deepEqual(executionStatusText({ executionId, state: "queued", retryCount: 0, runId: null, detail: null }, now),
    { label: "Queued", detail: "Waiting for the agent." });
  assert.deepEqual(executionStatusText({ executionId, state: "retrying", retryCount: 1, runId: null, detail: null }, now),
    { label: "Retrying", detail: "Attempt 2 starts automatically." });
  assert.deepEqual(executionStatusText({ executionId, state: "running", retryCount: 0, runId: detail.run.runId, detail }, now),
    { label: "Running · step 2", detail: "Type 4 characters · 00:05 · $0.0012" });
  assert.equal(executionStatusText({ executionId, state: "completed", retryCount: 0, runId: detail.run.runId, detail }, now).label, "Running");
  assert.equal(executionStatusText({ executionId, state: "failed", retryCount: 2, runId: null, detail: null }, now).detail,
    "The run could not start. Check the agent and model settings, then try again.");
});

test("the confirmed routine card keeps its saved state and mounts Run Now inside the action row", async () => {
  const source = (await import("node:fs")).readFileSync("components/chat/routine-card-actions.tsx", "utf8");
  assert.match(source, /RoutineRunNow/);
  assert.match(source, /routineId/);
  assert.match(source, /Routine saved/);
});
