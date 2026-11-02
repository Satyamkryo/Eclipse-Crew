import assert from "node:assert/strict";
import test from "node:test";

import { CANARY_PATTERN, canaryHash, canaryVariants, containsCanary, generateCanary } from "../lib/security/canary.ts";

const CANARY = `ecx-${"a".repeat(32)}`;

test("generated canaries use the fixed bait format and hash stably", () => {
  assert.match(generateCanary(), CANARY_PATTERN);
  assert.equal(canaryHash(CANARY), canaryHash(CANARY));
  assert.match(canaryHash(CANARY), /^[0-9a-f]{64}$/);
});

test("the variants cover the encodings a page or model could use", () => {
  const variants = canaryVariants(CANARY);
  for (const value of [
    CANARY,
    CANARY.toUpperCase(),
    CANARY.replace(/-/g, " "),
    encodeURIComponent(CANARY),
    Buffer.from(CANARY).toString("base64"),
    Buffer.from(CANARY).toString("base64url"),
    Buffer.from(CANARY).toString("hex"),
    [...CANARY].reverse().join(""),
  ]) {
    assert.equal(containsCanary(`prefix ${value} suffix`, CANARY), true, value);
  }
  assert.equal(variants.length > 0, true);
});

test("a canary split across two typed steps still matches", () => {
  const first = CANARY.slice(0, 20);
  const second = CANARY.slice(20);
  assert.equal(containsCanary(first, CANARY, ""), false);
  assert.equal(containsCanary(second, CANARY, first), true);
});

test("random lookalikes, another canary and the bare prefix do not match", () => {
  for (const text of [`ecx-${"b".repeat(32)}`, `ecx-${"c".repeat(32)}`, "d".repeat(32), "ecx-", "nothing here"]) {
    assert.equal(containsCanary(text, CANARY), false, text);
  }
});
