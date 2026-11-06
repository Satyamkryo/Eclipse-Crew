import assert from "node:assert/strict";
import test from "node:test";
import { confidenceGate } from "../lib/agent/confidence-gate.ts";
import { runTask } from "../lib/agent/step-loop.ts";

const target = { ref: 1, name: "Send", role: "button", tag: "button", x: 10, y: 10, width: 4, height: 3, focused: true };
const snapshot = { href: "https://example.test/", title: "Test", frames: 0, controls: [target] };
const shot = { base64: "fixture", width: 1024, height: 768 };
const point = { x: 12, y: 11, name: "Send", role: "button", method: "page_structure" };
const click = { action: "click", target: "Send", expect: "control_present: Sent" };
const visual = (extra = {}) => ({ observe: async () => ({ status: "pass", name: "Send", role: "button" }), verify: async () => "pass", ...extra });
const gate = (extra = {}) => confidenceGate({ intent: click, point, before: shot, snapshot, desktop: { snapshot: async () => snapshot }, services: { samState: "off", visual: visual() }, ...extra });

test("an irreversible step needs independent visual agreement; every target must still be fresh and unchanged", async () => {
  const result = await gate({ irreversible: true });
  assert.equal(result.allowed, true);
  assert.deepEqual(result.evidence.map(e => e.method), ["page_structure", "model"]);
  for (const observed of [{ status: "fail", name: "Send", role: "button" }, { status: "pass", name: "Delete", role: "button" }, { status: "unknown", name: "Send", role: "button" }]) {
    assert.equal((await gate({ irreversible: true, services: { samState: "off", visual: visual({ observe: async () => observed }) } })).allowed, false);
  }
  assert.equal((await gate({ desktop: { snapshot: async () => ({ ...snapshot, controls: [{ ...target, x: 11 }] }) } })).allowed, false);
  assert.equal((await gate({ desktop: { snapshot: async () => ({ ...snapshot, href: "https://example.test/other" }) } })).allowed, false);
});

test("a routine step makes no model request; page structure places it", async () => {
  const never = async () => { throw new Error("a routine step must not ask a model"); };
  const routine = await gate({ services: { samState: "off", visual: visual({ observe: never, confirmPoint: never }) } });
  assert.equal(routine.allowed, true);
  assert.deepEqual(routine.evidence.map((item) => [item.method, item.status]), [["page_structure", "pass"]], "the receipt never claims agreement it did not get");
});

test("an irreversible click: a pixel check can agree when the observer words the name differently, never over its refusal", async () => {
  const observer = (observed, confirmPoint) => gate({ irreversible: true, services: { samState: "off", visual: visual({ observe: async () => observed, confirmPoint }) } });
  const loose = { status: "pass", name: "Send it", role: "btn" };
  assert.equal((await observer(loose, async () => "pass")).allowed, true);
  assert.equal((await observer(loose, async () => "unknown")).allowed, false);
  assert.equal((await observer(loose, async () => "fail")).allowed, false);
  assert.equal((await observer({ status: "unknown", name: "", role: "" }, async () => "pass")).allowed, true);
  let asked = false;
  assert.equal((await observer({ status: "fail", name: "Send", role: "button" }, async () => { asked = true; return "pass"; })).allowed, false);
  assert.equal(asked, false, "a refusal is final");
});

test("routine typing and keys leave the focus check to the desktop worker, which reads the real focus", async () => {
  for (const intent of [{ action: "type", text: "x", expect: "typed" }, { action: "key", keys: "Control+a", expect: "selected" }]) {
    for (const page of [snapshot, null]) {
      const result = await gate({ intent, snapshot: page });
      assert.equal(result.allowed, true);
      assert.equal(result.evidence[0].code, "worker_checks_focus");
    }
  }
});

test("a routine control picked by its list number needs no name; a nameless one by words cannot be told apart", async () => {
  const unnamed = { ...target, name: "", focused: false };
  const page = { ...snapshot, controls: [unnamed] };
  const fresh = { desktop: { snapshot: async () => page } };
  const byRef = { ...point, name: "", ref: 1 };
  assert.equal((await gate({ point: byRef, snapshot: page, ...fresh })).allowed, true);
  assert.equal((await gate({ point: { ...point, name: "" }, snapshot: page, ...fresh })).allowed, false);
  assert.equal((await gate({ point: byRef, snapshot: page, irreversible: true, ...fresh })).allowed, false, "irreversible needs a name");
});

test("all potentially irreversible inputs fail closed without unique visible/focused evidence", async () => {
  for (const intent of [click, { action: "type", text: "hello", expect: "typed" }, { action: "key", keys: "Enter", expect: "sent" }]) {
    assert.equal((await gate({ intent, snapshot: null, irreversible: true })).allowed, false);
    assert.equal((await gate({ intent, snapshot: { ...snapshot, controls: [target, { ...target, ref: 2 }] }, irreversible: true })).allowed, false);
  }
  assert.equal((await gate({ intent: { action: "type", text: "x", expect: "typed" }, irreversible: true })).allowed, false, "button not editable");
  assert.equal((await gate({ intent: { action: "key", keys: "Enter", expect: "sent" }, snapshot: { ...snapshot, controls: [{ ...target, focused: false }] }, irreversible: true })).allowed, false);
  assert.equal((await gate({ snapshot: null })).allowed, false, "a click always needs a readable page");
});

test("SAM mask must uniquely cover the grounded pixel and agree geometrically; absent confidence is unknown", async () => {
  let modelCalls = 0;
  const mask = { box: { x1: 10, y1: 10, x2: 13, y2: 12 }, width: 4, height: 3, raster: new Uint8Array(12).fill(1), confidence: .95 };
  const services = { samState: "on", sam: { masks: async () => [mask] }, visual: visual({ observe: async () => { modelCalls++; return { status: "unknown", name: "", role: "" }; } }) };
  assert.equal((await gate({ services })).allowed, true);
  assert.equal(modelCalls, 0);
  for (const masks of [[], [mask, mask], [{ ...mask, confidence: null }], [{ ...mask, raster: new Uint8Array(12) }]]) {
    assert.equal((await gate({ irreversible: true, services: { ...services, sam: { masks: async () => masks } } })).allowed, false);
  }
  assert.equal(modelCalls, 4);
});

test("visual observer receives original intent without the DOM-derived answer or coordinates", async () => {
  let description;
  await gate({ irreversible: true, intent: { ...click, target: "Send the report" }, services: { samState: "off", visual: visual({ observe: async (_shot, data) => {
    description = data; return { status: "pass", name: "Send", role: "button" };
  } }) } });
  assert.deepEqual(JSON.parse(description), { action: "click", target: "Send the report" });
  assert.equal(/page_structure|"x"|"y"|"role"/.test(description), false);
});

const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0 };
const result = (intent) => ({ status: "completed", outputs: [{ type: "function_call", name: "next_step", callId: "c", arguments: JSON.stringify(intent) }], usage });
async function run({ intent = click, observed = { status: "pass", name: "Send", role: "button" }, verification = "pass", overrides = {} } = {}) {
  const input = []; const cards = []; let calls = 0;
  const localSnapshot = { ...snapshot, controls: [{ ...target, name: intent.action === "click" ? intent.target : "Send" }] };
  const desktop = { screenshot: async () => shot, snapshot: async () => localSnapshot, verify: async () => ({ status: verification, code: "visible_inventory" }),
    click: async () => input.push("click"), type: async () => input.push("type"), key: async () => input.push("key"), scroll: async () => input.push("scroll"), ...overrides };
  const output = await runTask({ agent: { id: "gate-test", name: "A", role: "R", soulMd: "", actions: ["click", "type", "key", "scroll", "wait"] }, task: "Send the report", model: "mock", timezone: "UTC",
    desktop, provider: { generate: async () => { calls++; return result(calls === 1 ? intent : { action: "finish", summary: "Done" }); } },
    verification: { samState: "off", visual: visual({ observe: async () => observed }) }, sleep: async () => {}, postCard: async (card) => cards.push(card),
    // TASK-050 runs the owner-approval step before this gate for Send/Delete/Purchase/Payment. Approving here isolates
    // the confidence gate; without an approvals port the loop correctly stops first (covered in agent-step-loop).
    approvals: { request: async () => ({ decision: "allow", waitedMs: 0, reason: "allowed_once" }) } });
  return { output, input, cards, calls };
}

test("run stops before send/delete/purchase/payment input when independent observations disagree", async () => {
  for (const target of ["Send", "Delete", "Purchase", "Payment hand-off"]) {
    const r = await run({ intent: { ...click, target }, observed: { status: "unknown", name: "", role: "" } });
    assert.equal(r.output.outcome, "needs_owner"); assert.deepEqual(r.input, []); assert.equal(r.cards.length, 1);
  }
  const r = await run({ intent: { action: "key", keys: "Enter", expect: click.expect }, observed: { status: "fail", name: "Send", role: "button" } });
  assert.deepEqual(r.input, []);
});

test("postcondition failure stops once after input, and successful checks are recorded honestly", async () => {
  const bad = await run({ verification: "fail" });
  assert.deepEqual(bad.input, ["click"]); assert.equal(bad.output.outcome, "needs_owner"); assert.equal(bad.calls, 1);
  assert.equal(bad.output.steps[0].verified, false); assert.equal(bad.output.steps[0].verification.status, "fail");
  assert.match(bad.cards[0].text, /action was attempted/);
  const good = await run();
  assert.equal(good.output.outcome, "finished"); assert.equal(good.output.steps[0].verified, true); assert.equal(good.output.steps[0].verification.sam, "off");
  assert.match(good.cards[0].text, /1 desktop step postcondition/);
});

test("takeover during verification records attempted input as unverified and pauses without another action", async () => {
  const r = await run({ overrides: { verify: async () => { throw Object.assign(new Error("fixture"), { code: "takeover_active" }); } } });
  assert.deepEqual(r.input, ["click"]); assert.equal(r.output.outcome, "paused_by_owner"); assert.equal(r.output.steps[0].verified, false);
  assert.equal(r.cards.length, 1);
});

test("production run wiring caps verification calls and adds their usage to the Main-model run", async () => {
  const requests = [], inputs = [], cards = [];
  const replies = [result({ ...click, expect: "Sent confirmation visible" }),
    { status: "completed", usage, outputs: [{ type: "function_call", name: "verification_result", callId: "v", arguments: JSON.stringify({ status: "pass", name: "Send", role: "button" }) }] },
    { status: "completed", usage, outputs: [{ type: "function_call", name: "verification_result", callId: "v", arguments: '{"status":"pass"}' }] },
    result({ action: "finish", summary: "Done" })];
  const output = await runTask({ agent: { id: "production-wiring", name: "A", role: "R", soulMd: "", actions: ["click"] }, task: "Send report", model: "muse-spark-1.3-contributor", timezone: "UTC",
    provider: { generate: async (request) => { requests.push(request); return replies.shift(); } },
    desktop: { screenshot: async () => shot, snapshot: async () => snapshot, click: async () => inputs.push("click") }, postCard: async card => cards.push(card),
    approvals: { request: async () => ({ decision: "allow", waitedMs: 0, reason: "allowed_once" }) } });
  assert.equal(output.outcome, "finished"); assert.deepEqual(inputs, ["click"]); assert.equal(cards.length, 1);
  assert.equal(requests.length, 4); assert.equal(output.usage.inputTokens, 4); assert.equal(output.usage.outputTokens, 4);
  assert.deepEqual(requests.map(r => r.tools[0].name), ["next_step", "verification_result", "verification_result", "next_step"]);
  assert.ok(requests.every(r => r.model === "muse-spark-1.3-contributor"));
  assert.deepEqual(requests.slice(1, 3).map(r => r.maxOutputTokens), [2048, 2048]);
});
