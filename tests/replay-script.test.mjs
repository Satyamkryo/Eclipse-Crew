import assert from "node:assert/strict";
import test from "node:test";

import { MAX_REPLAY_STEPS, compileFromReceipts, defaultScriptName, inputKeysOf, matchInputs, replayInputsSchema, replayStepSchema, replayStepsSchema } from "../lib/replay/script.ts";
import { REFUSAL_TEXT, stepText, toStepViews } from "../lib/replay/view.ts";

const receipt = (idx, over = {}) => ({
  idx, action: { kind: "wait" }, target: null, postcondition: "control_present: Invoices", result: "pass", executed: true, ...over,
});
const rows = (list) => list.map((item) => ({ idx: item.idx, receipt: typeof item === "string" ? item : JSON.stringify(item) }));
const clickReceipt = (idx, over = {}) => receipt(idx, { action: { kind: "click", target: "the download pdf link" }, target: { role: "link", name: "Download PDF" }, ...over });
const codes = (result) => result.reasons.map((reason) => `${reason.step}:${reason.code}`);

test("a verified run compiles to numbered steps: clicks keep the grounded control, typed text is never kept", () => {
  const result = compileFromReceipts(rows([
    clickReceipt(1, { postcondition: "url_path: /invoices" }),
    receipt(2, { action: { kind: "type", chars: 7 }, postcondition: "control_present: Invoice month" }),
    receipt(3, { action: { kind: "key", keys: "Enter" } }),
    receipt(4, { action: { kind: "scroll", direction: "down" }, postcondition: "control_absent: Reset demo" }),
    receipt(5),
    receipt(6, { action: { kind: "deliver_file", from: "downloads", name: "DEMO-1001.pdf" }, postcondition: "the file is in outbox", result: "executed" }),
  ]));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.steps.map((step) => [step.idx, step.action]), [[1, "click"], [2, "type"], [3, "key"], [4, "scroll"], [5, "wait"], [6, "deliver_file"]]);
  assert.deepEqual(result.steps[0], { idx: 1, action: "click", role: "link", name: "Download PDF", expect: "url_path: /invoices" });
  assert.deepEqual(result.steps[1], { idx: 2, action: "type", chars: 7, expect: "control_present: Invoice month" });
  assert.deepEqual(result.steps[5], { idx: 6, action: "deliver_file", from: "downloads", file: "DEMO-1001.pdf" });
  assert.equal(replayStepsSchema.safeParse(result.steps).success, true);
  // The model's own description of the click is not part of the script.
  assert.equal(JSON.stringify(result.steps).includes("the download pdf link"), false);
  assert.deepEqual(inputKeysOf(result.steps), ["2"]);
});

test("steps are renumbered 1..n by position even when receipts skip numbers", () => {
  const result = compileFromReceipts(rows([receipt(3), receipt(5)]));
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map((step) => step.idx), [1, 2]);
});

test("a run that cannot be replayed without a model is refused with the step and a fixed code", () => {
  const cases = [
    [[receipt(1, { result: "fail" })], "1:step_not_verified"],
    [[receipt(1, { result: "blocked", executed: false })], "1:step_not_verified"],
    [[receipt(1, { result: "unknown" })], "1:step_not_verified"],
    [[receipt(1, { executed: false })], "1:step_not_verified"],
    [[receipt(1, { action: { kind: "read_document", name: "a.pdf", offset: 0 }, result: "executed" })], "1:step_not_replayable"],
    [[receipt(1, { action: { kind: "teleport" } })], "1:step_not_replayable"],
    [[receipt(1, { postcondition: "the page looks right" })], "1:postcondition_not_structural"],
    [[receipt(1, { postcondition: "object_visible: Download PDF" })], "1:postcondition_not_structural"],
    [[receipt(1, { postcondition: "" })], "1:postcondition_not_structural"],
    [[receipt(1, { postcondition: "url_path: /a?b=1" })], "1:postcondition_not_structural"],
    [[clickReceipt(1, { target: null })], "1:control_unknown"],
    [[receipt(1, { action: { kind: "key", keys: "Control" } })], "1:step_not_replayable"],
    [[receipt(1, { action: { kind: "type", chars: 0 } })], "1:step_not_replayable"],
    [[receipt(1, { action: { kind: "deliver_file", from: "downloads", name: "../x" }, result: "executed" })], "1:step_not_replayable"],
    [[receipt(1, { action: { kind: "click" }, target: { role: "link", name: "a\u0000b" } })], "1:step_not_replayable"],
  ];
  for (const [list, expected] of cases) {
    const result = compileFromReceipts(rows(list));
    assert.equal(result.ok, false, expected);
    assert.equal(codes(result)[0], expected);
  }
  assert.deepEqual(codes(compileFromReceipts(rows([]))), ["null:no_steps"]);
  assert.deepEqual(codes(compileFromReceipts([{ idx: 1, receipt: "not json" }])), ["1:receipt_unreadable"]);
  assert.deepEqual(codes(compileFromReceipts([{ idx: 1, receipt: "[]" }])), ["1:receipt_unreadable"]);
  assert.deepEqual(codes(compileFromReceipts(rows(Array.from({ length: MAX_REPLAY_STEPS + 1 }, (_, i) => receipt(i + 1))))), ["null:too_many_steps"]);
  assert.equal(compileFromReceipts(rows(Array.from({ length: MAX_REPLAY_STEPS }, (_, i) => receipt(i + 1)))).ok, true);
});

test("every bad step is reported, up to ten", () => {
  const result = compileFromReceipts(rows(Array.from({ length: 15 }, (_, i) => receipt(i + 1, { result: "fail" }))));
  assert.equal(result.ok, false);
  assert.equal(result.reasons.length, 10);
});

test("the stored step schema is strict: coordinates, selectors, typed text and model-only postconditions are refused", () => {
  const click = { idx: 1, action: "click", role: "link", name: "Download PDF", expect: "control_present: A" };
  assert.equal(replayStepSchema.safeParse(click).success, true);
  for (const bad of [
    { ...click, x: 10, y: 20 }, { ...click, selector: "#a" }, { ...click, text: "secret" }, { ...click, expect: "object_visible: A" },
    { ...click, expect: "it worked" }, { ...click, name: "" }, { ...click, name: "x".repeat(201) },
    { idx: 1, action: "type", chars: 3, text: "abc", expect: "control_present: A" }, { idx: 1, action: "type", text: "abc", expect: "control_present: A" },
    { idx: 1, action: "shell", command: "ls" }, { ...click, idx: 0 },
  ]) assert.equal(replayStepSchema.safeParse(bad).success, false, JSON.stringify(bad));
  assert.equal(replayStepsSchema.safeParse([{ ...click, idx: 2 }]).success, false, "numbering must start at 1");
  assert.equal(replayStepsSchema.safeParse([]).success, false);
});

test("replay inputs: exactly one value per type step, bounded and free of control characters", () => {
  const steps = compileFromReceipts(rows([receipt(1, { action: { kind: "type", chars: 3 } }), receipt(2), receipt(3, { action: { kind: "type", chars: 2 } })])).steps;
  assert.deepEqual([...matchInputs(steps, { 1: "abc", 3: "de" })], [[1, "abc"], [3, "de"]]);
  assert.equal(matchInputs(steps, { 1: "abc" }), null, "missing value");
  assert.equal(matchInputs(steps, { 1: "abc", 3: "de", 2: "x" }), null, "value for a step that takes none");
  assert.equal(matchInputs(steps, {}), null);
  assert.equal(matchInputs(compileFromReceipts(rows([receipt(1)])).steps, {}).size, 0, "no type steps need no values");
  assert.equal(replayInputsSchema.safeParse({ 1: "line one\nline two" }).success, true, "a newline is allowed in typed text");
  for (const bad of [{ 1: "" }, { 1: "a".repeat(2001) }, { 1: "a\u0000b" }, { one: "a" }, { 100: "a" }, { 1: 5 }])
    assert.equal(replayInputsSchema.safeParse(bad).success, false, JSON.stringify(bad));
  assert.deepEqual(replayInputsSchema.parse(undefined), {});
});

test("names and labels", () => {
  assert.equal(defaultScriptName("Replay: Download the invoice"), "Download the invoice");
  assert.equal(defaultScriptName("  Get\nthe   invoice\u0000 "), "Get the invoice");
  assert.equal(defaultScriptName(""), "Saved replay");
  assert.equal(defaultScriptName("x".repeat(200)).length, 80);
  assert.equal(stepText({ idx: 1, action: "click", role: "link", name: "Download PDF" }), "Click link “Download PDF”");
  assert.deepEqual(toStepViews([{ idx: 1, action: "type", chars: 3 }, { idx: 2, action: "key", keys: "Enter" }]), [
    { idx: 1, text: "Type your text", needsText: true }, { idx: 2, text: "Press Enter", needsText: false }]);
  assert.ok(Object.keys(REFUSAL_TEXT).length >= 9);
});
