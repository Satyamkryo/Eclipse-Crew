import assert from "node:assert/strict";
import test from "node:test";
import { getForwardedKeyChord } from "../lib/desktop/key-chord.ts";

const event = (overrides = {}) => ({
  key: "a",
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  altGraph: false,
  ...overrides,
});

test("AltGraph and unsupported base keys are not forwarded", () => {
  assert.equal(getForwardedKeyChord(event({ key: "@", ctrlKey: true, altKey: true, altGraph: true })), null);
  for (const key of ["@", "é", "Dead", "Unidentified", "F13"]) {
    assert.equal(getForwardedKeyChord(event({ key, ctrlKey: true })), null);
  }
});

test("supported named keys and modifier chords use the normalized base key", () => {
  assert.equal(getForwardedKeyChord(event({ key: "Enter" })), "Enter");
  assert.equal(getForwardedKeyChord(event({ key: " ", ctrlKey: true })), "Control+Space");
  assert.equal(getForwardedKeyChord(event({ key: "ArrowLeft", ctrlKey: true, shiftKey: true })), "Control+Shift+ArrowLeft");
  assert.equal(getForwardedKeyChord(event({ key: "a", ctrlKey: true, altKey: true, metaKey: true })), "Control+Alt+Meta+a");
});

test("unmodified text and space remain available to textarea input", () => {
  assert.equal(getForwardedKeyChord(event({ key: "a" })), null);
  assert.equal(getForwardedKeyChord(event({ key: " " })), null);
});
