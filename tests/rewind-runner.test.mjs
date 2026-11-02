import assert from "node:assert/strict";
import test from "node:test";

import { runTask } from "../lib/agent/step-loop.ts";

const AGENT = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZfJ8AAAAASUVORK5CYII=";
const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0 };
const call = (intent) => ({
  id: "r", model: "mock", status: "completed", incompleteReason: null, text: "", usage,
  outputs: [{ type: "function_call", callId: "c1", name: "next_step", arguments: JSON.stringify(intent) }],
});
const timeStep = call({ action: "get_time", timezone: "UTC" });
const finishStep = call({ action: "finish", summary: "Done." });

const resume = {
  history: [{ step: 4, action: "click", target: "Invoices", expect: "url_path: /invoices", result: "executed" }],
  documents: [{ name: "report.pdf", offset: 100 }],
  delivered: ["invoice.pdf"],
  turn: 4,
};

test("a resumed run sends the saved history, the correction and the re-read document, and continues its step numbers", async () => {
  const calls = []; const reads = []; const captures = []; const events = [];
  const provider = {
    kind: "meta",
    generate: async (request) => { calls.push(request); return calls.length === 1 ? timeStep : finishStep; },
    listModels: async () => [], detectCapabilities: async () => ({}),
  };
  const desktop = {
    screenshot: async () => ({ base64: PNG, width: 1024, height: 768 }),
    snapshot: async () => ({ href: "https://example.test/", title: "Invoices", frames: 0, controls: [] }),
    click: async () => { throw new Error("no earlier action may be executed"); },
    type: async () => { throw new Error("no earlier action may be executed"); },
    key: async () => { throw new Error("no earlier action may be executed"); },
    scroll: async () => { throw new Error("no earlier action may be executed"); },
    readDocument: async (name, offset) => {
      reads.push([name, offset]);
      return { kind: "text", format: "text", truncated: false, text: "Document text.", offset, nextOffset: null, totalChars: 14 };
    },
  };
  const receipts = {
    runId: RUN,
    begin: async () => events.push("begin"), step: async () => events.push("step"),
    seal: async (status) => events.push(`seal:${status}`),
  };
  const checkpoints = { capture: async (idx, snapshot) => captures.push({ idx, snapshot }) };
  let started = 0; let released = 0; const cards = [];

  const result = await runTask({
    agent: { id: AGENT, name: "Ada", role: "Researcher", soulMd: "Careful.", actions: ["click"] },
    task: "Collect invoices.\n\nOwner correction: Check the March dates.",
    provider, model: "mock", desktop, receipts, checkpoints, timezone: "UTC",
    resume, claimed: () => { released += 1; }, onStarted: () => { started += 1; },
    postCard: async (card) => { cards.push(card); },
  });

  assert.equal(result.outcome, "finished");
  assert.deepEqual(events, ["begin", "seal:finished"]);
  assert.equal(started, 1, "the branch start signal fires after the receipts begin");
  assert.equal(released, 1, "the held lock is released once");
  assert.deepEqual(reads, [["report.pdf", 100]], "the saved document window is read again");
  assert.equal(calls.length, 2);
  const first = JSON.stringify(calls[0]);
  assert.match(first, /Invoices/, "saved history reaches the first model call");
  assert.match(first, /Check the March dates/, "the owner correction is part of the task");
  assert.match(first, /report\.pdf/, "the re-read document reaches the first model call");
  assert.match(first, /Document text\./);
  const secondHistory = calls[1].messages[0].content.find((part) => part.type === "text" && part.sourceTag === "agent");
  const previous = JSON.parse(secondHistory.text).previous_steps;
  assert.equal(previous[previous.length - 1].step, 5, "new steps continue after the resumed turn");
  assert.equal(captures[0].idx, 0);
  assert.equal(captures[0].snapshot.turn, 4);
  assert.equal(captures[0].snapshot.receiptIdx, 0);
  assert.equal(captures[0].snapshot.history.length, 1);
  assert.deepEqual(captures[0].snapshot.documents, [{ name: "report.pdf", window: { kind: "text", offset: 100 } }]);
  assert.deepEqual(captures[0].snapshot.delivered, ["invoice.pdf"]);
  assert.equal(result.steps.length, 0);
  assert.equal(cards.length, 1);
});

test("a document that can no longer be read is dropped and the run continues", async () => {
  const calls = [];
  const provider = { kind: "meta", generate: async (request) => { calls.push(request); return finishStep; }, listModels: async () => [], detectCapabilities: async () => ({}) };
  const desktop = {
    screenshot: async () => ({ base64: PNG, width: 1024, height: 768 }), snapshot: async () => ({ href: "https://example.test/", title: "", frames: 0, controls: [] }),
    click: async () => {}, type: async () => {}, key: async () => {}, scroll: async () => {},
    readDocument: async () => { throw Object.assign(new Error("file_not_found"), { code: "file_not_found" }); },
  };
  const result = await runTask({
    agent: { id: AGENT, name: "Ada", role: "R", soulMd: "", actions: [] },
    task: "Task", provider, model: "mock", desktop, timezone: "UTC",
    resume: { ...resume, history: [] }, claimed: () => {}, onStarted: () => {}, postCard: async () => {},
  });
  assert.equal(result.outcome, "finished");
  assert.equal(JSON.stringify(calls[0]).includes("report.pdf"), false, "the dropped document is not sent");
});

test("a failed receipt start never signals that the branch began", async () => {
  let started = 0; let released = 0;
  const result = await runTask({
    agent: { id: AGENT, name: "Ada", role: "R", soulMd: "", actions: [] },
    task: "Task", provider: { kind: "meta", generate: async () => finishStep, listModels: async () => [], detectCapabilities: async () => ({}) },
    model: "mock", desktop: { screenshot: async () => ({ base64: PNG, width: 1, height: 1 }), snapshot: async () => ({ href: "", title: "", frames: 0, controls: [] }), click: async () => {}, type: async () => {}, key: async () => {}, scroll: async () => {} },
    receipts: { runId: RUN, begin: async () => { throw new Error("db down"); }, step: async () => {}, seal: async () => {} },
    timezone: "UTC", claimed: () => { released += 1; }, onStarted: () => { started += 1; }, postCard: async () => {},
  });
  assert.equal(result.outcome, "receipt_error");
  assert.equal(started, 0);
  assert.equal(released, 1);
});
