import assert from "node:assert/strict";
import test from "node:test";
import { namesAgent, parseMention } from "../lib/chat/mentions.ts";
import { validHandoffNote } from "../lib/agent/handoff.ts";
import { buildHeader } from "../lib/receipts/chain.mjs";

const RUN = "22222222-2222-4222-8222-222222222222";
const SENDER = "33333333-3333-4333-8333-333333333333";

test("a leading @Name routes one teammate; later @ is ordinary text", () => {
  assert.deepEqual(parseMention("@Scout find my next meeting"), { name: "Scout", text: "find my next meeting" });
  assert.deepEqual(parseMention("   @scout   check the calendar"), { name: "scout", text: "check the calendar" });
  assert.equal(parseMention("email me @scout"), null);
  assert.equal(parseMention("hello @scout, are you there"), null);
  assert.equal(parseMention("@Scout"), null);
  assert.equal(parseMention("@@Scout hi"), null);
});

test("agent names match case-insensitively but exactly otherwise", () => {
  assert.equal(namesAgent("Scout", "scout"), true);
  assert.equal(namesAgent("Scout", "SCOUT"), true);
  assert.equal(namesAgent("Scout", "Sco"), false);
  assert.equal(namesAgent("Scout Two", "Scout"), false);
});

test("a handoff note is one line of at most 1,000 characters", () => {
  assert.equal(validHandoffNote("Please check the calendar."), true);
  assert.equal(validHandoffNote("x".repeat(1000)), true);
  assert.equal(validHandoffNote("x".repeat(1001)), false);
  assert.equal(validHandoffNote("line one\nline two"), false);
  assert.equal(validHandoffNote("   "), false);
});

test("a helper header names its parent run and step; earlier headers stay unchanged", () => {
  const base = { runId: RUN, agentId: SENDER, agentName: "Atlas", task: "Find the invoices", startedAt: "2026-11-03T00:00:00.000Z", keyId: "sha256:" + "a".repeat(64) };
  const plain = buildHeader(base);
  assert.equal(plain.text.includes("parent_run"), false);
  assert.match(plain.text, /"task":"Find the invoices"/);
  const child = buildHeader({ ...base, parentRun: RUN, parentStep: 4 });
  assert.match(child.text, /"parent_run":"22222222-2222-4222-8222-222222222222"/);
  assert.match(child.text, /"parent_step":4/);
  assert.throws(() => buildHeader({ ...base, parentRun: RUN, parentStep: -1 }), /Invalid helper header/);
  assert.throws(() => buildHeader({ ...base, parentRun: "not-a-uuid", parentStep: 1 }), /Invalid helper header/);
});
