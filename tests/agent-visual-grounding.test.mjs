import assert from "node:assert/strict";
import test from "node:test";
import { confidenceGate } from "../lib/agent/confidence-gate.ts";
import { runTask } from "../lib/agent/step-loop.ts";
import { createComputerLocator, groundVisually, maskPoint, supportsComputerUse, uniqueMask } from "../lib/agent/visual-grounding.ts";

const shot = { base64: "fixture", width: 1024, height: 768 };
const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0 };
// A 10x10 solid mask at (100, 200).
const mask = (extra = {}) => ({ id: 1, box: { x1: 100, y1: 200, x2: 109, y2: 209 }, width: 10, height: 10, area: 100, raster: new Uint8Array(100).fill(1), confidence: 0.95, ...extra });
const computerCall = (action, checks = []) => ({ status: checks.length ? "safety_review_required" : "completed", usage,
  outputs: [{ type: "computer_call", callId: "call_1", actions: [action], pendingSafetyChecks: checks, replayItems: [] }] });

test("mask point is the centroid, or the nearest set pixel when the centroid is empty", () => {
  assert.deepEqual(maskPoint(mask()), { x: 105, y: 205 });
  const ring = new Uint8Array(100);
  for (let i = 0; i < 10; i++) { ring[i] = 1; ring[90 + i] = 1; ring[i * 10] = 1; ring[i * 10 + 9] = 1; }
  const point = maskPoint(mask({ raster: ring }));
  const local = { x: point.x - 100, y: point.y - 200 };
  assert.equal(ring[local.y * 10 + local.x], 1);
  assert.equal(maskPoint(mask({ raster: new Uint8Array(100) })), null);
});

test("only one confident mask counts", () => {
  assert.ok(uniqueMask([mask()]));
  assert.equal(uniqueMask([]), null);
  assert.equal(uniqueMask([mask(), mask({ id: 2 })]), null);
  assert.equal(uniqueMask([mask({ confidence: 0.5 })]), null);
  assert.equal(uniqueMask([mask({ confidence: null })]), null);
});

test("cascade tries SAM first, then computer use, and swallows rung failures but not budget stops", async () => {
  const computer = { locate: async () => ({ x: 7, y: 8 }) };
  assert.equal((await groundVisually("Chart", shot, { sam: { masks: async () => [mask()] }, computer })).method, "sam");
  const fallback = await groundVisually("Chart", shot, { sam: { masks: async () => [mask(), mask({ id: 2 })] }, computer });
  assert.deepEqual({ x: fallback.x, y: fallback.y, method: fallback.method }, { x: 7, y: 8, method: "computer_use" });
  assert.equal(await groundVisually("Chart", shot, { sam: { masks: async () => { throw new Error("sam_unavailable"); } } }), null);
  assert.equal(await groundVisually("Chart", shot, { computer: { locate: async () => ({ x: 5000, y: 1 }) } }), null, "out of bounds");
  await assert.rejects(groundVisually("Chart", shot, { sam: { masks: async () => { throw Object.assign(new Error("x"), { code: "budget_paused" }); } } }), { code: "budget_paused" });
});

test("computer use is offered only for Meta models whose profile supports it", () => {
  const meta = { kind: "meta", continueComputer: async () => {} };
  assert.equal(supportsComputerUse(meta, "muse-spark-1.3-contributor"), true);
  assert.equal(supportsComputerUse(meta, "muse-spark-1.3"), true);
  assert.equal(supportsComputerUse(meta, "muse-spark-1.2"), false);
  assert.equal(supportsComputerUse({ kind: "openai-compatible", continueComputer: async () => {} }, "muse-spark-1.3"), false);
  assert.equal(supportsComputerUse({ kind: "meta" }, "muse-spark-1.3"), false);
});

function locator({ first = computerCall({ type: "screenshot" }), second = computerCall({ type: "click", button: "left", x: 40, y: 50 }) } = {}) {
  const seen = { generate: [], continuations: [] };
  const provider = { kind: "meta",
    generate: async (request) => { seen.generate.push(request); return first; },
    continueComputer: async (continuation) => { seen.continuations.push(continuation); return second; } };
  const spent = [];
  const instance = createComputerLocator({ provider, model: "muse-spark-1.3-contributor", task: "Open the report", timezone: "UTC", now: () => new Date(0), usage: (u) => spent.push(u) });
  return { instance, seen, spent };
}

test("native computer use: observe this step's screenshot, then exactly one left click", async () => {
  const { instance, seen, spent } = locator();
  assert.deepEqual(await instance.locate(shot, "Report chart"), { x: 40, y: 50 });
  assert.equal(seen.generate[0].computerUse, true);
  assert.equal(seen.generate[0].model, "muse-spark-1.3-contributor");
  assert.equal(seen.generate[0].messages[0].content[0].sourceTag, "user");
  assert.equal(seen.generate[0].messages[0].content[1].sourceTag, "agent");
  assert.deepEqual(seen.continuations[0].screenshot, { mediaType: "image/png", base64: "fixture" });
  assert.deepEqual(seen.continuations[0].acknowledgedSafetyChecks, []);
  assert.equal(spent.length, 2);
});

test("native computer use refuses guesses, safety checks, other actions and out-of-bounds clicks", async () => {
  const cases = [
    { first: computerCall({ type: "click", button: "left", x: 1, y: 1 }) },
    { first: computerCall({ type: "screenshot" }, [{ id: "s1", code: "irreversible_action" }]) },
    { second: computerCall({ type: "click", button: "left", x: 1, y: 1 }, [{ id: "s2", code: "sensitive_domain" }]) },
    { second: computerCall({ type: "type", text: "hello" }) },
    { second: computerCall({ type: "click", button: "right", x: 1, y: 1 }) },
    { second: computerCall({ type: "click", button: "left", x: 1024, y: 1 }) },
    { second: { status: "completed", usage, outputs: [{ type: "message", text: "The target is not visible." }] } },
  ];
  for (const input of cases) assert.equal(await locator(input).instance.locate(shot, "Report chart"), null);
  assert.equal(await locator().instance.locate(shot, "bad\u0000target"), null);
});

const click = { action: "click", target: "Report chart", expect: "control_present: Details" };
const page = { href: "https://example.test/", title: "Test", frames: 0, controls: [] };
const visual = (extra = {}) => ({ observe: async () => ({ status: "unknown", name: "", role: "" }), verify: async () => "pass", ...extra });
const samPoint = () => ({ x: 105, y: 205, method: "sam", mask: mask() });
const gate = (extra = {}) => confidenceGate({ intent: click, point: samPoint(), before: shot, snapshot: page,
  desktop: { snapshot: async () => page }, services: { samState: "on", visual: visual() }, visual: {}, irreversible: false, ...extra });

test("visual click: two agreeing location methods pass, even for irreversible actions", async () => {
  const result = await gate({ irreversible: true, visual: { computer: { locate: async () => ({ x: 103, y: 207 }) } } });
  assert.equal(result.allowed, true);
  assert.deepEqual(result.evidence.map((e) => [e.method, e.status]), [["sam", "pass"], ["computer_use", "pass"]]);
  const outside = await gate({ irreversible: true, visual: { computer: { locate: async () => ({ x: 300, y: 300 }) } } });
  assert.equal(outside.allowed, false);
});

test("visual click: computer-use point needs a unique SAM mask covering it", async () => {
  const point = { x: 105, y: 205, method: "computer_use" };
  assert.equal((await gate({ point, irreversible: true, visual: { sam: { masks: async () => [mask()] } } })).allowed, true);
  assert.equal((await gate({ point, irreversible: true, visual: { sam: { masks: async () => [mask(), mask({ id: 2 })] } } })).allowed, false);
});

test("irreversible visual click with one method hands off without asking the model", async () => {
  let asked = 0;
  const result = await gate({ irreversible: true, services: { samState: "on", visual: visual({ confirmPoint: async () => { asked++; return "pass"; } }) } });
  assert.equal(result.allowed, false);
  assert.equal(asked, 0);
  assert.equal(result.evidence.at(-1).code, "second_method_unavailable");
});

test("ordinary visual click may use the model's pixel check as the second method", async () => {
  let seen;
  const ok = await gate({ services: { samState: "on", visual: visual({ confirmPoint: async (_s, target, point) => { seen = { target, point }; return "pass"; } }) } });
  assert.equal(ok.allowed, true);
  assert.deepEqual(seen, { target: "Report chart", point: samPoint() });
  for (const status of ["unknown", "fail"]) {
    assert.equal((await gate({ services: { samState: "on", visual: visual({ confirmPoint: async () => status }) } })).allowed, false);
  }
  assert.equal((await gate({ services: { samState: "on", visual: visual() } })).allowed, false, "no pixel check available");
});

test("visual click is refused on payment pages and when the page changed", async () => {
  const confirm = { samState: "on", visual: visual({ confirmPoint: async () => "pass" }) };
  assert.equal((await gate({ services: confirm, snapshot: { ...page, paymentFrames: 1 } })).allowed, false);
  assert.equal((await gate({ services: confirm, desktop: { snapshot: async () => ({ ...page, href: "https://example.test/other" }) } })).allowed, false);
});

const intentResult = (intent) => ({ status: "completed", outputs: [{ type: "function_call", name: "next_step", callId: "c", arguments: JSON.stringify(intent) }], usage });
async function run({ intent = click, grounders, confirm = "pass", approvals } = {}) {
  const input = []; const cards = []; let calls = 0;
  const desktop = { screenshot: async () => shot, snapshot: async () => page, verify: async () => ({ status: "pass", code: "visible_inventory" }),
    click: async (x, y) => input.push(["click", x, y]), type: async () => {}, key: async () => {}, scroll: async () => {} };
  const output = await runTask({ agent: { id: "visual-test", name: "A", role: "R", soulMd: "", actions: ["click", "type", "key", "scroll", "wait"] },
    task: "Open the report", model: "mock", timezone: "UTC", desktop,
    provider: { generate: async () => { calls++; return intentResult(calls <= 2 ? intent : { action: "finish", summary: "Done" }); } },
    verification: { samState: "on", visual: visual({ confirmPoint: async () => confirm }) }, visualGrounders: grounders,
    sleep: async () => {}, postCard: async (card) => cards.push(card), ...(approvals ? { approvals } : {}) });
  return { output, input, cards };
}

test("loop: after page structure misses twice, a SAM-grounded click runs at the mask point", async () => {
  const r = await run({ grounders: { sam: { masks: async () => [mask()] } } });
  assert.deepEqual(r.input, [["click", 105, 205]]);
  assert.equal(r.output.steps.at(-1)?.groundingMethod ?? r.output.steps.find((s) => s.executed)?.groundingMethod, "sam");
});

test("loop: without visual grounders the step still hands off", async () => {
  const r = await run({ grounders: {} });
  assert.deepEqual(r.input, []);
  assert.equal(r.output.outcome, "needs_owner");
});

test("loop: an irreversible visual click with only SAM stops before input", async () => {
  const r = await run({ intent: { ...click, target: "Send" }, grounders: { sam: { masks: async () => [mask()] } },
    approvals: { request: async () => ({ decision: "allow", waitedMs: 0, reason: "allowed_once" }) } });
  assert.deepEqual(r.input, []);
  assert.equal(r.output.outcome, "needs_owner");
});
