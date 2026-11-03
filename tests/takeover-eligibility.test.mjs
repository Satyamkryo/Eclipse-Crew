// Takeover eligibility input policy (docs/DESIGN.md; prompt 2026-11-03-ui-reference-alignment.md).
// Unit tests for the evidence rules: trusted mouse + trusted non-composing keyboard, nothing else.
import { test } from "node:test";
import assert from "node:assert/strict";

const { confirmKeyboardEvidence, confirmPointerEvidence, isTakeoverEligible, resetTakeoverEvidence } =
  await import("../components/desktop/use-takeover-eligibility.ts");

function fresh() {
  resetTakeoverEvidence();
  assert.equal(isTakeoverEligible(), false);
}

test("starts view-only and needs both input kinds", () => {
  fresh();
  assert.equal(confirmPointerEvidence({ isTrusted: true, pointerType: "mouse", button: 0 }), true);
  // Mouse alone does not pass.
  assert.equal(isTakeoverEligible(), false);
  assert.equal(confirmKeyboardEvidence({ isTrusted: true, isComposing: false, key: "Enter" }), true);
  assert.equal(isTakeoverEligible(), true);
});

test("keyboard alone and reverse order also require the mouse action", () => {
  fresh();
  assert.equal(confirmKeyboardEvidence({ isTrusted: true, isComposing: false, key: "a" }), true);
  assert.equal(isTakeoverEligible(), false);
  assert.equal(confirmPointerEvidence({ isTrusted: true, pointerType: "mouse", button: 0 }), true);
  assert.equal(isTakeoverEligible(), true);
});

test("touch and pen pointers never count as the mouse action", () => {
  fresh();
  assert.equal(confirmPointerEvidence({ isTrusted: true, pointerType: "touch", button: 0 }), false);
  assert.equal(confirmPointerEvidence({ isTrusted: true, pointerType: "pen", button: 0 }), false);
  assert.equal(isTakeoverEligible(), false);
});

test("synthetic (untrusted) events are ignored for both inputs", () => {
  fresh();
  assert.equal(confirmPointerEvidence({ isTrusted: false, pointerType: "mouse", button: 0 }), false);
  assert.equal(confirmKeyboardEvidence({ isTrusted: false, isComposing: false, key: "Enter" }), false);
  assert.equal(isTakeoverEligible(), false);
});

test("composing (IME) keyboard events do not count", () => {
  fresh();
  assert.equal(confirmKeyboardEvidence({ isTrusted: true, isComposing: true, key: "a" }), false);
  assert.equal(isTakeoverEligible(), false);
});

test("modifier-only keys do not count as typing evidence", () => {
  fresh();
  for (const key of ["Shift", "Control", "Alt", "Meta", "CapsLock", ""]) {
    assert.equal(confirmKeyboardEvidence({ isTrusted: true, isComposing: false, key }), false);
  }
  assert.equal(isTakeoverEligible(), false);
});

test("reset clears both kinds and blocks again", () => {
  fresh();
  confirmPointerEvidence({ isTrusted: true, pointerType: "mouse", button: 0 });
  confirmKeyboardEvidence({ isTrusted: true, isComposing: false, key: "Enter" });
  assert.equal(isTakeoverEligible(), true);
  resetTakeoverEvidence();
  assert.equal(isTakeoverEligible(), false);
});

test("right-click and non-primary buttons are not evidence", () => {
  fresh();
  assert.equal(confirmPointerEvidence({ isTrusted: true, pointerType: "mouse", button: 2 }), false);
  assert.equal(isTakeoverEligible(), false);
});
