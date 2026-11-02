import assert from "node:assert/strict";
import test from "node:test";

import { CHAT_RUN_TEXT, runChatMessage } from "../lib/agent/chat-run.ts";
import { runTask } from "../lib/agent/step-loop.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const AGENT = "33333333-3333-4333-8333-333333333333";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZfJ8AAAAASUVORK5CYII=";
const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0 };
const finishStep = (summary) => ({
  id: "r", model: "m", status: "completed", incompleteReason: null, text: "", usage,
  outputs: [{ type: "function_call", callId: "c1", name: "next_step", arguments: JSON.stringify({ action: "finish", summary }) }],
});
const desktop = () => ({
  screenshot: async () => ({ base64: PNG, width: 1024, height: 768 }),
  snapshot: async () => ({ href: "https://a.example/", title: "A", frames: 0, controls: [] }),
  click: async () => {}, type: async () => {}, key: async () => {}, scroll: async () => {},
});
const persona = { id: AGENT, name: "Ada", role: "Researcher", soulMd: "Be careful.", actions: ["click", "type"] };

test("saved optional SAM transport reaches the server-side run without serializing credentials", async () => {
  const transport = async () => Response.json({});
  let captured;
  const samConfig = { state: "on", transport };
  const { ports } = setup({ start: { ok: true, persona, timezone: "UTC", provider: {}, model: "mock", hardModel: null, samConfig, desktop: desktop() },
    run: async (deps) => { captured = deps; return { outcome: "finished", cardPosted: true }; } });
  assert.equal(await runChatMessage(OWNER, AGENT, "A task", ports), "started");
  assert.equal(captured.samConfig, samConfig);
  assert.equal(captured.samConfig.transport, transport);
});

function setup({ start, run = runTask, provider } = {}) {
  const cards = []; const calls = []; const runIds = [];
  const generate = async (request) => { calls.push(request); return finishStep("It is noon."); };
  const ports = {
    prepare: async () => start ?? { ok: true, persona, timezone: "Asia/Kolkata", model: "muse", desktop: desktop(),
      provider: provider ?? { kind: "meta", listModels: async () => [], detectCapabilities: async () => ({}), generate } },
    postCard: async (_owner, _agent, card, runId) => { cards.push(card); runIds.push(runId); },
    run,
  };
  return { ports, cards, calls, runIds };
}

test("a chat message runs the task once and the run ends with exactly one card", async () => {
  const { ports, cards, calls } = setup();
  assert.equal(await runChatMessage(OWNER, AGENT, "What time is it?", ports), "started");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].type, "message");
  assert.match(cards[0].text, /^It is noon\./);
  assert.equal(calls.length, 1);
  assert.match(JSON.stringify(calls[0]), /What time is it\?/);
});

test("missing model or desktop gives one fixed card and no run", async () => {
  for (const reason of ["no_model", "unavailable", "no_signing_key"]) {
    let ran = false;
    const { ports, cards } = setup({ start: { ok: false, reason }, run: async () => { ran = true; return { outcome: "finished", cardPosted: true }; } });
    assert.equal(await runChatMessage(OWNER, AGENT, "hello", ports), reason);
    assert.equal(ran, false);
    assert.deepEqual(cards, [{ type: "message", text: CHAT_RUN_TEXT[reason] }]);
  }
});

test("a second message while the agent is busy posts the busy card once and starts no second run", async () => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const first = setup({ provider: { kind: "meta", listModels: async () => [], detectCapabilities: async () => ({}), generate: async () => { await gate; return finishStep("First done."); } } });
  const second = setup();
  const running = runChatMessage(OWNER, AGENT, "first", first.ports);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await runChatMessage(OWNER, AGENT, "second", second.ports), "busy");
  assert.deepEqual(second.cards, [{ type: "message", text: CHAT_RUN_TEXT.busy }]);
  assert.equal(second.calls.length, 0);
  release();
  assert.equal(await running, "started");
  assert.equal(first.cards.length, 1);
  assert.match(first.cards[0].text, /^First done\./);
});

test("errors never reach the chat as details and never throw", async () => {
  const boom = setup({ run: async () => { throw new Error("secret-token-123 upstream exploded"); } });
  assert.equal(await runChatMessage(OWNER, AGENT, "hello", boom.ports), "failed");
  assert.deepEqual(boom.cards, [{ type: "message", text: CHAT_RUN_TEXT.unavailable }]);
  assert.ok(!JSON.stringify(boom.cards).includes("secret-token"));

  const prepareFails = setup();
  prepareFails.ports.prepare = async () => { throw new Error("db down"); };
  assert.equal(await runChatMessage(OWNER, AGENT, "hello", prepareFails.ports), "failed");

  const postFails = setup();
  postFails.ports.postCard = async () => { throw new Error("db down"); };
  postFails.ports.prepare = async () => ({ ok: false, reason: "no_model" });
  assert.equal(await runChatMessage(OWNER, AGENT, "hello", postFails.ports), "no_model");
});

test("the saved hard-step model reaches the run; without one the run is Fixed", async () => {
  for (const hardModel of ["muse-wonder-1.0", null]) {
    let seen;
    const { ports } = setup({ start: { ok: true, persona, timezone: "UTC", model: "muse", hardModel, desktop: desktop(), provider: { kind: "meta" } },
      run: async (deps) => { seen = deps; return { outcome: "finished", cardPosted: true }; } });
    assert.equal(await runChatMessage(OWNER, AGENT, "hello", ports), "started");
    assert.equal(seen.hardModel, hardModel);
    assert.equal(seen.model, "muse");
  }
});

test("the receipt sink is built for the message, handed to the run, and its run id reaches the result card", async () => {
  const RUN = "99999999-9999-4999-8999-999999999999";
  const events = [];
  const sink = { runId: RUN, begin: async () => { events.push("begin"); }, step: async () => { events.push("step"); }, seal: async (status) => { events.push(`seal:${status}`); } };
  let task;
  const { ports, cards, runIds } = setup({ start: { ok: true, persona, timezone: "UTC", model: "muse", hardModel: null, desktop: desktop(),
    provider: { kind: "meta", listModels: async () => [], detectCapabilities: async () => ({}), generate: async () => finishStep("Done.") },
    receipts: (text) => { task = text; return sink; } } });
  assert.equal(await runChatMessage(OWNER, AGENT, "Open settings", ports), "started");
  assert.equal(task, "Open settings");
  assert.deepEqual(events, ["begin", "seal:finished"]);
  assert.equal(cards.length, 1);
  assert.deepEqual(runIds, [RUN]);
});

test("the no-signing-key card names the fix and nothing else", () => {
  assert.match(CHAT_RUN_TEXT.no_signing_key, /npm run receipt-key/);
  assert.match(CHAT_RUN_TEXT.no_signing_key, /docker compose up -d/);
});
