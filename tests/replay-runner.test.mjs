import assert from "node:assert/strict";
import test from "node:test";

import { runTask } from "../lib/agent/step-loop.ts";
import { runReplay } from "../lib/replay/runner.ts";
import { runSavedReplay } from "../lib/replay/ports.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZfJ8AAAAASUVORK5CYII=";
const SHOT = { base64: PNG, width: 1024, height: 768 };
const AGENT = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-11-02T12:00:00.000Z");
const SECRET = "hunter2-do-not-store";

const control = (role, name, i = 0, extra = {}) => ({ ref: i + 1, role, name, tag: "div", x: 100, y: 100 + i * 60, width: 80, height: 30, ...extra });
const pageOf = (controls, href = "https://vendor.example/") => ({ href, title: "Vendor", frames: 0, controls });
const layoutA = () => pageOf([control("link", "Download PDF", 0), control("textbox", "Invoice month", 1, { focused: true }), control("button", "Apply filter", 2)]);
const layoutB = () => pageOf([control("link", "Get invoice", 0), control("textbox", "Billing period", 1, { focused: true })]);

const STEPS = [
  { idx: 1, action: "click", role: "link", name: "Download PDF", expect: "control_present: Apply filter" },
  { idx: 2, action: "type", chars: SECRET.length, expect: "control_present: Invoice month" },
  { idx: 3, action: "key", keys: "Enter", expect: "url_path: /" },
  { idx: 4, action: "wait", expect: "control_present: Apply filter" },
];

function desktop(over = {}) {
  const calls = [];
  const port = {
    calls,
    screenshot: async () => { calls.push(["screenshot"]); return SHOT; },
    snapshot: async () => { calls.push(["snapshot"]); return layoutA(); },
    verify: async (predicate) => { calls.push(["verify", predicate.kind, predicate.value]); return { status: "pass", code: "ok" }; },
    click: async (x, y) => { calls.push(["click", x, y]); },
    type: async (text) => { calls.push(["type", text]); },
    key: async (key) => { calls.push(["key", key]); },
    scroll: async (direction, count) => { calls.push(["scroll", direction, count]); },
    ...over,
  };
  return port;
}
const inputCalls = (calls) => calls.filter(([name]) => ["click", "type", "key", "scroll"].includes(name));

function harness(over = {}) {
  const receipts = []; const events = []; const evidence = []; const checkpoints = []; const cards = []; let seal = null; let begun = 0;
  const deps = {
    agent: { id: AGENT, name: "Ada", actions: ["click", "type", "key", "scroll", "wait", "deliver_file"] },
    script: { name: "Download invoice", steps: STEPS },
    inputs: new Map([[2, SECRET]]),
    desktop: desktop(),
    receipts: { runId: AGENT, begin: async () => { begun += 1; events.push("begin"); }, step: async (input) => { receipts.push(input); events.push(`step${input.idx}`); },
      seal: async (status, usage) => { seal = { status, usage }; events.push("seal"); } },
    evidence: { record: async (input) => { evidence.push(input); events.push(`evidence${input.idx}`); } },
    checkpoints: { capture: async (idx, snapshot) => { checkpoints.push({ idx, snapshot }); events.push(`checkpoint${idx}`); } },
    postCard: async (card) => { cards.push(card); },
    approvals: async () => "allowed",
    now: () => NOW, sleep: async () => {},
    ...over,
  };
  return { deps, receipts, events, evidence, checkpoints, cards, seal: () => seal, begun: () => begun, run: () => runReplay(deps) };
}

test("a replay checks every step with the page alone, makes no model call, and leaves a sealed zero-cost proof", async () => {
  const h = harness();
  const result = await h.run();
  assert.equal(result.outcome, "finished");
  assert.deepEqual(result.done, [1, 2, 3, 4]);
  assert.deepEqual(inputCalls(h.deps.desktop.calls), [["click", 140, 115], ["type", SECRET], ["key", "Enter"]]);
  assert.deepEqual(h.cards, [{ type: "message", text: "Replay finished: 4 steps checked, no model used." }]);
  assert.deepEqual(h.receipts.map((r) => [r.idx, r.action.kind, r.result, r.executed]), [[1, "click", "pass", true], [2, "type", "pass", true], [3, "key", "pass", true], [4, "wait", "pass", true]]);
  for (const r of h.receipts) {
    assert.deepEqual([r.model, r.model_label, r.route, r.sam, r.cost_micro_usd], ["none", "No model", "replay", "off", 0]);
    assert.deepEqual(r.usage, { input: 0, output: 0, cached: 0, reasoning: 0 });
    assert.equal(r.confidence, "medium", "one method (page structure) passed, so never high");
    // Click, type and key are gated on the page; wait and scroll have no target, so they carry only the postcondition check.
    assert.deepEqual(r.methods.map((m) => [m.phase, m.method, m.status]),
      r.action.kind === "wait" ? [["verify", "page_structure", "pass"]] : [["gate", "page_structure", "pass"], ["verify", "page_structure", "pass"]]);
    assert.match(r.before_hash, /^[0-9a-f]{64}$/); assert.match(r.after_hash, /^[0-9a-f]{64}$/);
  }
  assert.deepEqual(h.receipts[0].target, { role: "link", name: "Download PDF" });
  assert.equal(h.receipts[0].grounding_method, "page_structure");
  assert.equal(h.receipts[1].action.chars, SECRET.length);
  assert.deepEqual(h.seal(), { status: "finished", usage: { input: 0, output: 0, cached: 0, reasoning: 0 } });
  // Same order as the step loop: a checkpoint before step 1, then receipt, evidence, checkpoint for each step, then the seal.
  assert.deepEqual(h.events, ["begin", "checkpoint0", "step1", "evidence1", "checkpoint1", "step2", "evidence2", "checkpoint2", "step3", "evidence3", "checkpoint3", "step4", "evidence4", "checkpoint4", "seal"]);
  assert.deepEqual(h.checkpoints.map((c) => c.idx), [0, 1, 2, 3, 4]);
  assert.equal(h.evidence.length, 4);
});

test("typed text reaches the desktop once and appears in no receipt, checkpoint or card", async () => {
  const h = harness();
  await h.run();
  assert.equal(h.deps.desktop.calls.filter(([name]) => name === "type").length, 1);
  const stored = JSON.stringify([h.receipts, h.checkpoints, h.cards, h.evidence.map((e) => ({ idx: e.idx })), h.seal()]);
  assert.equal(stored.includes(SECRET), false);
  assert.equal(h.checkpoints.at(-1).snapshot.history.find((item) => item.action === "type").chars, SECRET.length);
});

test("when the site changed (layout B) the first click stops the run with no input and a blocked receipt", async () => {
  const h = harness({ desktop: desktop({ snapshot: async () => layoutB() }) });
  const result = await h.run();
  assert.equal(result.outcome, "needs_owner");
  assert.deepEqual(result.stoppedAt, { step: 1, code: "target_missing" });
  assert.deepEqual(inputCalls(h.deps.desktop.calls), []);
  assert.deepEqual(h.receipts.map((r) => [r.idx, r.result, r.executed, r.code]), [[1, "blocked", false, "target_missing"]]);
  assert.equal(h.receipts[0].confidence, "low");
  assert.deepEqual(h.seal().status, "needs_owner");
  assert.equal(h.cards.length, 1);
  assert.equal(h.cards[0].text, "Replay stopped at step 1: the control this step needs is not on the page. Take over or ask me to redo it.");
});

test("two controls with the same role and name are ambiguous: nothing is clicked", async () => {
  const twice = pageOf([control("link", "Download PDF", 0), control("link", "Download PDF", 1)]);
  const h = harness({ desktop: desktop({ snapshot: async () => twice }) });
  const result = await h.run();
  assert.deepEqual(result.stoppedAt, { step: 1, code: "ambiguous_target" });
  assert.deepEqual(inputCalls(h.deps.desktop.calls), []);
});

test("an unreadable page, a role mismatch and a moved control all stop before input", async () => {
  const unreadable = harness({ desktop: desktop({ snapshot: async () => { throw Object.assign(new Error("x"), { code: "page_unavailable" }); } }) });
  assert.deepEqual((await unreadable.run()).stoppedAt, { step: 1, code: "page_unreadable" });
  assert.deepEqual(inputCalls(unreadable.deps.desktop.calls), []);

  const wrongRole = harness({ desktop: desktop({ snapshot: async () => pageOf([control("button", "Download PDF", 0)]) }) });
  assert.deepEqual((await wrongRole.run()).stoppedAt, { step: 1, code: "target_missing" });

  let reads = 0;
  const moved = harness({ desktop: desktop({ snapshot: async () => { reads += 1; return reads === 1 ? layoutA() : pageOf([control("link", "Download PDF", 3), control("textbox", "Invoice month", 1, { focused: true })]); } }) });
  const result = await moved.run();
  assert.deepEqual(result.stoppedAt, { step: 1, code: "target_changed" });
  assert.deepEqual(inputCalls(moved.deps.desktop.calls), []);
  assert.deepEqual(moved.receipts.map((r) => r.methods.map((m) => m.code)), [["unique_target", "target_changed"]]);

  let pages = 0;
  const navigated = harness({ desktop: desktop({ snapshot: async () => { pages += 1; return pages === 1 ? layoutA() : pageOf(layoutA().controls, "https://vendor.example/other"); } }) });
  assert.deepEqual((await navigated.run()).stoppedAt, { step: 1, code: "target_changed" });
});

test("a type step needs exactly one focused text field", async () => {
  const noFocus = pageOf([control("link", "Download PDF", 0), control("textbox", "Invoice month", 1)]);
  let reads = 0;
  const lost = harness({ desktop: desktop({ snapshot: async () => { reads += 1; return reads <= 2 ? layoutA() : noFocus; } }) });
  const result = await lost.run();
  assert.deepEqual(result.stoppedAt, { step: 2, code: "unsupported_focus" });
  assert.deepEqual(inputCalls(lost.deps.desktop.calls), [["click", 140, 115]], "the click ran; the typing did not");

  const onButton = harness({ desktop: desktop({ snapshot: async () => pageOf([control("link", "Download PDF", 0), control("button", "Apply filter", 1, { focused: true })]) }) });
  assert.deepEqual((await onButton.run()).stoppedAt, { step: 2, code: "unsupported_focus" });
  assert.equal(onButton.deps.desktop.calls.some(([name]) => name === "type"), false);

  const two = pageOf([control("textbox", "A", 0, { focused: true }), control("textbox", "B", 1, { focused: true }), control("link", "Download PDF", 2)]);
  const ambiguous = harness({ script: { name: "x", steps: [STEPS[1]] }, desktop: desktop({ snapshot: async () => two }) });
  assert.deepEqual((await ambiguous.run()).stoppedAt, { step: 2, code: "ambiguous_target" });
});

test("scroll and wait steps have no target to check: they run on a page with no focused control", async () => {
  const noFocus = pageOf([control("link", "Download PDF", 0), control("button", "Apply filter", 1)]);
  const steps = [{ idx: 1, action: "scroll", direction: "down", expect: "control_present: Apply filter" }, { idx: 2, action: "wait", expect: "control_present: Apply filter" }];
  const h = harness({ script: { name: "x", steps }, desktop: desktop({ snapshot: async () => noFocus }) });
  assert.equal((await h.run()).outcome, "finished");
  assert.deepEqual(inputCalls(h.deps.desktop.calls), [["scroll", "down", 3]]);
  assert.deepEqual(h.receipts.map((r) => [r.action.kind, r.result, r.methods.map((m) => m.phase)]), [["scroll", "pass", ["verify"]], ["wait", "pass", ["verify"]]]);
  assert.equal(h.deps.desktop.calls.some(([name]) => name === "snapshot"), false);
});

test("a failed postcondition is retried three times, recorded as fail, and stops the run before the next step", async () => {
  const sleeps = [];
  let checks = 0;
  const h = harness({ sleep: async (ms) => { sleeps.push(ms); },
    desktop: desktop({ verify: async () => { checks += 1; return { status: "fail", code: "control_missing" }; } }) });
  const result = await h.run();
  assert.equal(result.outcome, "needs_owner");
  assert.deepEqual(result.stoppedAt, { step: 1, code: "postcondition_failed" });
  assert.equal(checks, 3);
  assert.deepEqual(sleeps, [500, 500]);
  assert.deepEqual(inputCalls(h.deps.desktop.calls), [["click", 140, 115]]);
  assert.deepEqual(h.receipts.map((r) => [r.result, r.executed, r.confidence]), [["fail", true, "low"]]);
});

test("an unknown or missing postcondition check is a mismatch, never a pass", async () => {
  const unknown = harness({ desktop: desktop({ verify: async () => ({ status: "unknown", code: "page_unavailable" }) }) });
  assert.deepEqual((await unknown.run()).stoppedAt, { step: 1, code: "postcondition_unknown" });
  assert.equal(unknown.receipts[0].result, "unknown");

  const none = harness({ desktop: desktop({ verify: undefined }) });
  assert.deepEqual((await none.run()).stoppedAt, { step: 1, code: "postcondition_unknown" });

  const prose = harness({ script: { name: "x", steps: [{ ...STEPS[0], expect: "the invoice downloads" }] } });
  assert.deepEqual((await prose.run()).stoppedAt, { step: 1, code: "postcondition_unknown" });
  assert.equal(prose.deps.desktop.calls.some(([name]) => name === "verify"), false, "a non-structural check is never sent to the page");
});

test("takeover stops the replay and a later step is never driven", async () => {
  const takeover = () => Object.assign(new Error("takeover"), { code: "takeover_active" });
  const before = harness({ desktop: desktop({ screenshot: async () => { throw takeover(); } }) });
  assert.equal((await before.run()).outcome, "paused_by_owner");
  assert.deepEqual(inputCalls(before.deps.desktop.calls), []);
  assert.equal(before.cards[0].text, "I stopped because you took over the desktop.");

  const snap = harness({ desktop: desktop({ snapshot: async () => { throw takeover(); } }) });
  assert.equal((await snap.run()).outcome, "paused_by_owner");

  const during = harness({ desktop: desktop({ click: async () => { throw takeover(); } }) });
  const result = await during.run();
  assert.equal(result.outcome, "paused_by_owner");
  assert.deepEqual(during.receipts.map((r) => [r.result, r.executed, r.code]), [["failed", false, "takeover_active"]]);
  assert.equal(during.seal().status, "paused_by_owner");
  assert.equal(during.deps.desktop.calls.some(([name]) => name === "type"), false);
});

test("an action removed from the agent's allowlist stops the run at that step without a receipt", async () => {
  const h = harness({ agent: { id: AGENT, name: "Ada", actions: ["click", "type", "wait"] } });
  const result = await h.run();
  assert.equal(result.outcome, "needs_owner");
  assert.deepEqual(result.stoppedAt, { step: 3, code: "action_not_allowed" });
  assert.deepEqual(result.done, [1, 2]);
  assert.deepEqual(inputCalls(h.deps.desktop.calls), [["click", 140, 115], ["type", SECRET]]);
  assert.equal(h.receipts.length, 2);
  const none = harness({ agent: { id: AGENT, name: "Ada", actions: [] } });
  assert.deepEqual((await none.run()).stoppedAt, { step: 1, code: "action_not_allowed" });
  assert.deepEqual(none.deps.desktop.calls, []);
});

test("abort and the wall clock stop the run between steps", async () => {
  const controller = new AbortController();
  controller.abort();
  const aborted = harness({ signal: controller.signal });
  assert.equal((await aborted.run()).outcome, "aborted");
  assert.deepEqual(aborted.deps.desktop.calls, []);

  let clock = NOW.getTime();
  const slow = harness({ now: () => new Date(clock), desktop: desktop({ screenshot: async () => { clock += 20 * 60_000; return SHOT; } }) });
  const result = await slow.run();
  assert.equal(result.outcome, "time_limit");
  assert.equal(slow.seal().status, "time_limit");
  assert.equal(slow.cards[0].text, "I stopped because this run reached its time limit.");
  assert.equal(inputCalls(slow.deps.desktop.calls).length <= 1, true);
});

test("a hung desktop call is cut off by the wall clock", async () => {
  const h = harness({ maxWallClockMs: 20, desktop: desktop({ screenshot: () => new Promise(() => {}) }) });
  const result = await h.run();
  assert.equal(result.outcome, "time_limit");
  assert.deepEqual(inputCalls(h.deps.desktop.calls), []);
});

test("a missing value for a type step starts nothing", async () => {
  const h = harness({ inputs: new Map() });
  const result = await h.run();
  assert.equal(result.outcome, "needs_owner");
  assert.deepEqual(result.stoppedAt, { step: 2, code: "input_missing" });
  assert.equal(h.begun(), 0, "no run row is opened");
  assert.deepEqual(h.deps.desktop.calls, []);
  assert.equal(h.seal(), null);
});

test("a receipt that cannot be stored stops the run before the next input", async () => {
  const h = harness();
  h.deps.receipts.step = async () => { throw new Error("db down"); };
  const result = await h.run();
  assert.equal(result.outcome, "receipt_error");
  assert.deepEqual(inputCalls(h.deps.desktop.calls), [["click", 140, 115]]);
  assert.equal(h.cards[0].text, "I stopped because I could not record proof of my last step.");

  const noStart = harness();
  noStart.deps.receipts.begin = async () => { throw new Error("db down"); };
  assert.equal((await noStart.run()).outcome, "receipt_error");
  assert.deepEqual(noStart.deps.desktop.calls, []);
});

test("evidence and checkpoint failures never stop a replay", async () => {
  const h = harness();
  h.deps.evidence.record = async () => { throw new Error("disk full"); };
  h.deps.checkpoints.capture = async () => { throw new Error("disk full"); };
  assert.equal((await h.run()).outcome, "finished");
});

test("file steps: delivered files get their card; a failure is a mismatch with a failed receipt", async () => {
  const steps = [{ idx: 1, action: "deliver_file", from: "downloads", file: "DEMO-1001.pdf" }];
  const delivered = [];
  const ok = harness({ script: { name: "x", steps }, onFileDelivered: async (file) => { delivered.push(file.name); },
    desktop: desktop({ deliverFile: async (from, name) => ({ name, from }) }) });
  assert.equal((await ok.run()).outcome, "finished");
  assert.deepEqual(delivered, ["DEMO-1001.pdf"]);
  assert.deepEqual(ok.receipts.map((r) => [r.action.kind, r.result, r.confidence, r.model]), [["deliver_file", "executed", "none", "none"]]);
  assert.deepEqual(ok.deps.desktop.calls, [], "a file step never touches the screen");

  const failed = harness({ script: { name: "x", steps }, desktop: desktop({ deliverFile: async () => { throw Object.assign(new Error("x"), { code: "file_not_found" }); } }) });
  const result = await failed.run();
  assert.deepEqual(result.stoppedAt, { step: 1, code: "file_failed" });
  assert.deepEqual(failed.receipts.map((r) => [r.result, r.executed, r.code]), [["failed", false, "file_not_found"]]);

  const unsupported = harness({ script: { name: "x", steps } });
  assert.deepEqual((await unsupported.run()).stoppedAt, { step: 1, code: "action_not_allowed" });
});

test("a failed card post is reported in the result and the lock is released", async () => {
  const h = harness({ postCard: async () => { throw new Error("db down"); } });
  const result = await h.run();
  assert.equal(result.outcome, "finished");
  assert.equal(result.cardPosted, false);
  assert.equal((await harness().run()).outcome, "finished");
});

test("a replay and a chat run cannot drive the same agent at once, in either order", async () => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const slow = harness({ desktop: desktop({ screenshot: async () => { await gate; return SHOT; } }) });
  const first = slow.run();
  await new Promise((resolve) => setImmediate(resolve));

  const second = harness();
  const busy = await second.run();
  assert.equal(busy.outcome, "busy");
  assert.deepEqual([second.begun(), second.deps.desktop.calls, second.cards], [0, [], []]);

  const provider = { kind: "meta", listModels: async () => [], detectCapabilities: async () => ({}), generate: async () => { throw new Error("must not be called"); } };
  const cards = [];
  const chat = await runTask({
    agent: { id: AGENT, name: "Ada", role: "r", soulMd: "s", actions: ["click"] }, task: "Open the page.", provider, model: "m", desktop: desktop(),
    timezone: "UTC", now: () => NOW, sleep: async () => {}, postCard: async (card) => { cards.push(card); },
  });
  assert.equal(chat.outcome, "busy");
  assert.equal(cards.length, 0);
  release();
  assert.equal((await first).outcome, "finished");

  // The other direction: a chat run holds the screen, a replay is refused.
  let letGo; const hold = new Promise((resolve) => { letGo = resolve; });
  const running = runTask({
    agent: { id: AGENT, name: "Ada", role: "r", soulMd: "s", actions: ["click"] }, task: "Open the page.", model: "m", timezone: "UTC", now: () => NOW,
    desktop: desktop(), postCard: async () => {}, sleep: async () => {},
    provider: { ...provider, generate: async () => { await hold; return { id: "r", model: "m", status: "completed", incompleteReason: null, text: "", usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0 },
      outputs: [{ type: "function_call", callId: "c", name: "next_step", arguments: JSON.stringify({ action: "finish", summary: "Done." }) }] }; } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await harness().run()).outcome, "busy");
  letGo();
  assert.equal((await running).outcome, "finished");
});

test("runSavedReplay: no model is needed, a busy agent gets one fixed card, unavailable setups say so", async () => {
  const posted = [];
  const h = harness();
  const ports = (prepare, run) => ({ prepare, run, postCard: async (_o, _a, card, runId) => { posted.push({ card, runId }); } });
  const script = { agentId: AGENT, name: "Download invoice", steps: STEPS };
  const good = { ok: true, persona: h.deps.agent, desktop: h.deps.desktop, receipts: () => h.deps.receipts, evidence: () => h.deps.evidence, checkpoints: () => h.deps.checkpoints, approvals: async () => "allowed" };
  assert.equal(await runSavedReplay(OWNER, script, h.deps.inputs, ports(async () => good, (deps) => runReplay(deps))), "started");
  assert.deepEqual(posted.map((p) => [p.card.text, p.runId]), [["Replay finished: 4 steps checked, no model used.", AGENT]]);

  posted.length = 0;
  assert.equal(await runSavedReplay(OWNER, script, h.deps.inputs, ports(async () => ({ ok: false, reason: "no_signing_key" }), async () => assert.fail("must not run"))), "no_signing_key");
  assert.match(posted[0].card.text, /receipt signing is not set up/);
  posted.length = 0;
  assert.equal(await runSavedReplay(OWNER, script, h.deps.inputs, ports(async () => ({ ok: false, reason: "unavailable" }), async () => assert.fail("must not run"))), "unavailable");
  posted.length = 0;
  assert.equal(await runSavedReplay(OWNER, script, h.deps.inputs, ports(async () => good, async () => ({ outcome: "busy", done: [], stoppedAt: null, cardPosted: false }))), "busy");
  assert.match(posted[0].card.text, /still working on another run/);
  posted.length = 0;
  assert.equal(await runSavedReplay(OWNER, script, h.deps.inputs, ports(async () => { throw new Error("boom"); }, async () => assert.fail("must not run"))), "failed");
  assert.equal(posted.length, 1);
  assert.equal(JSON.stringify(posted).includes("boom"), false, "error details never reach the chat");
});

test("TASK-050: a replay without a saved grant stops before a risky step and never waits", async () => {
  const h = harness({ approvals: async () => "approval_required" });
  const result = await h.run();
  assert.equal(result.outcome, "needs_owner");
  assert.deepEqual(result.stoppedAt, { step: 1, code: "approval_required" });
  assert.deepEqual(inputCalls(h.deps.desktop.calls), []);
  assert.deepEqual([h.receipts[0].result, h.receipts[0].code], ["blocked", "approval_required"]);
  assert.match(h.cards[0].text, /saved approval with capacity/);
});
