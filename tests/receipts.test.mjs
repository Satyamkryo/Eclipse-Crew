import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureReceiptKey } from "../scripts/receipt-key.mjs";

import {
  EXPORT_FORMAT, REASONS, buildHeader, buildReceipt, buildRunExport, canonicalJson, cleanText, deriveKeys, keyIdOf, sealRun,
  sha256Hex, verifyRunExport,
} from "../lib/receipts/chain.mjs";
import { actionFor, confidenceFor, screenshotHash } from "../lib/receipts/fields.ts";
import { loadReceiptSigner } from "../lib/receipts/signer.ts";
import { matchControl } from "../lib/agent/grounding.ts";
import { runTask } from "../lib/agent/step-loop.ts";
import { requireReceiptSigningKey } from "../lib/config/server.ts";

const SEED_A = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"; // RFC 8032 test vector 1
const PUBLIC_A = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const SEED_B = "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb";
const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "11111111-1111-4111-8111-111111111111";
const OWNER_NOW = new Date("2026-11-01T12:00:00.000Z");
const ZERO = { input: 0, output: 0, cached: 0, reasoning: 0 };

// ---- a small in-memory sink that uses the real chain code ----
function memorySink({ seed = SEED_A, runId = RUN_ID, failStepAt = 0, failBegin = false, failSeal = false } = {}) {
  const keys = deriveKeys(seed);
  const rows = []; let header; let head; let sealRow = null; let begun = false;
  const sink = {
    runId, rows,
    async begin() {
      if (failBegin) throw new Error("db down");
      header = buildHeader({ runId, agentId: AGENT, agentName: "Ada", task: "Open the settings page.", startedAt: OWNER_NOW.toISOString(), keyId: keys.keyId });
      head = header.hash; begun = true;
    },
    async step(input) {
      if (failStepAt && input.idx === failStepAt) throw new Error("db down");
      const receipt = buildReceipt({ run_id: runId, agent_id: AGENT, at: OWNER_NOW.toISOString(), ...input }, head);
      rows.push({ idx: input.idx, receiptText: receipt.text, receiptHash: receipt.hash, prevHash: head });
      head = receipt.hash;
    },
    async seal(status, usage) {
      if (failSeal) throw new Error("db down");
      const endedAt = OWNER_NOW.toISOString();
      const signature = sealRun(keys.privateKey, { runId, headerHash: header.hash, stepCount: rows.length, headHash: head, status, endedAt, usage });
      sealRow = { status, endedAt, stepCount: rows.length, headHash: head, usage, signature };
    },
    export() {
      return buildRunExport({ runId, headerText: header.text, headerHash: header.hash, keyId: keys.keyId, publicKey: keys.publicKey, seal: sealRow }, rows);
    },
    get begun() { return begun; }, get sealed() { return sealRow !== null; }, keys,
  };
  return sink;
}

// A sealed export with `count` receipts, built the same way production does.
async function sealedExport(count = 4, options = {}) {
  const sink = memorySink(options);
  await sink.begin();
  for (let idx = 1; idx <= count; idx++) {
    await sink.step({ idx, model: "m", model_label: "m", route: "main", action: { kind: "wait" }, target: null, grounding_method: null, methods: [], sam: "off", confidence: "medium",
      before_hash: null, after_hash: null, postcondition: `expect ${idx}`, result: "pass", code: null, executed: true, usage: ZERO, cost_micro_usd: null });
  }
  await sink.seal("finished", { input: 4, output: 2, cached: 0, reasoning: 1 });
  return sink.export();
}
const clone = (value) => JSON.parse(JSON.stringify(value));
const rehash = (step, receipt) => { step.receipt = canonicalJson(receipt); step.receipt_hash = sha256Hex(step.receipt); };

// ---- canonical JSON and keys ----
test("canonical JSON is stable, sorted, integer-only and rejects ambiguous values", () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, "x\u00e9"], c: { z: 0, y: -3 } }), '{"a":[true,null,"x\u00e9"],"b":1,"c":{"y":-3,"z":0}}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  for (const bad of [1.5, NaN, Infinity, undefined, () => 1, 10n, new Date(), { a: undefined }, "\ud800", Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(() => canonicalJson(bad), undefined, String(bad));
  }
  let deep = {}; for (let i = 0; i < 40; i++) deep = { deep };
  assert.throws(() => canonicalJson(deep));
});

test("the signing seed derives the documented Ed25519 public key; bad seeds are refused", () => {
  const keys = deriveKeys(SEED_A);
  assert.equal(Buffer.from(keys.publicKey, "base64url").toString("hex"), PUBLIC_A);
  assert.equal(keys.keyId, `sha256:${createHash("sha256").update(Buffer.from(PUBLIC_A, "hex")).digest("hex")}`);
  assert.equal(keys.keyId, keyIdOf(Buffer.from(PUBLIC_A, "hex")));
  for (const bad of ["", "abc", SEED_A.toUpperCase(), `${SEED_A}0`, null, undefined, 5]) assert.throws(() => deriveKeys(bad));
  assert.throws(() => requireReceiptSigningKey("nope"), /receipt-key/);
  assert.throws(() => loadReceiptSigner(undefined), /receipt-key/);
  const signer = loadReceiptSigner(SEED_A);
  assert.equal(signer.keyId, keys.keyId);
  assert.ok(!JSON.stringify({ ...signer, privateKey: undefined }).includes(SEED_A), "the seed is not part of the signer");
});

test("cleanText strips control characters and bounds untrusted page text", () => {
  assert.equal(cleanText("Pay \u001b[31mnow\u0007\nplease\u2028!", 100), "Pay [31mnow please !");
  assert.equal(cleanText("x".repeat(500), 200).length, 200);
  assert.equal(cleanText(42, 10), "");
});

// ---- chain and verification ----
test("an untouched sealed run verifies; a pin on the right key also passes", async () => {
  const exported = await sealedExport(4);
  assert.equal(exported.format, EXPORT_FORMAT);
  assert.deepEqual(verifyRunExport(exported), { ok: true, runId: RUN_ID, keyId: deriveKeys(SEED_A).keyId, steps: 4, pinned: false });
  const pinned = verifyRunExport(exported, { pinnedKeyId: deriveKeys(SEED_A).keyId });
  assert.equal(pinned.ok, true); assert.equal(pinned.pinned, true);
  assert.deepEqual(verifyRunExport(JSON.parse(JSON.stringify(exported))).ok, true, "survives a JSON round trip");
  const empty = await sealedExport(0);
  assert.equal(verifyRunExport(empty).ok, true, "a run with no steps can be sealed and verified");
  assert.ok(exported.steps.every((step, i) => step.prev_hash === (i ? exported.steps[i - 1].receipt_hash : exported.header_hash)));
});

test("verification fails for every kind of tampering, with the failing step named", async () => {
  const base = await sealedExport(4);
  const fails = (mutate, reason, step) => {
    const copy = clone(base); mutate(copy);
    const result = verifyRunExport(copy);
    assert.equal(result.ok, false, `${reason} must fail`); assert.equal(result.reason, reason);
    if (step !== undefined) assert.equal(result.step, step);
    assert.ok(REASONS.includes(result.reason));
  };
  fails((e) => { e.steps[1].receipt = e.steps[1].receipt.replace('"expect 2"', '"expect X"'); }, "receipt_hash_mismatch", 2);
  fails((e) => { const r = JSON.parse(e.steps[1].receipt); r.result = "fail"; rehash(e.steps[1], r); }, "prev_hash_mismatch", 3);
  fails((e) => { const r = JSON.parse(e.steps[3].receipt); r.result = "fail"; rehash(e.steps[3], r); }, "head_hash_mismatch");
  fails((e) => { e.steps.splice(1, 1); }, "step_missing", 2);
  fails((e) => { e.steps.splice(3, 1); }, "step_count_mismatch");
  fails((e) => { e.steps.splice(0, 1); }, "step_missing", 1);
  fails((e) => { [e.steps[1], e.steps[2]] = [e.steps[2], e.steps[1]]; }, "step_order", 2);
  fails((e) => { e.steps.push(clone(e.steps[0])); }, "step_order");
  fails((e) => { e.steps[2].idx = 9; }, "step_missing", 3);
  fails((e) => { e.steps[2].prev_hash = "0".repeat(64); }, "prev_hash_mismatch", 3);
  fails((e) => { e.header = e.header.replace("Open the settings page.", "Wire the money."); }, "header_hash_mismatch");
  fails((e) => { e.seal.status = "step_limit"; }, "bad_signature");
  fails((e) => { e.seal.usage.input = 0; }, "bad_signature");
  fails((e) => { e.seal.ended_at = "2026-11-02T12:00:00.000Z"; }, "bad_signature");
  fails((e) => { e.seal.signature = Buffer.alloc(64, 1).toString("base64url"); }, "bad_signature");
  fails((e) => { e.seal.head_hash = "f".repeat(64); }, "head_hash_mismatch");
  fails((e) => { e.seal.step_count = 3; }, "step_count_mismatch");
  fails((e) => { e.seal = null; }, "unsealed");
  fails((e) => { e.public_key = deriveKeys(SEED_B).publicKey; }, "key_id_mismatch");
  fails((e) => { e.run_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; }, "header_mismatch");
  fails((e) => { e.format = "other"; }, "bad_format");
});

test("a run re-signed by another key passes alone but fails against the pinned fingerprint", async () => {
  const forged = await sealedExport(3, { seed: SEED_B });
  assert.equal(verifyRunExport(forged).ok, true, "internally consistent files verify without a pin");
  const result = verifyRunExport(forged, { pinnedKeyId: deriveKeys(SEED_A).keyId });
  assert.deepEqual([result.ok, result.reason], [false, "pin_mismatch"]);
  assert.equal(verifyRunExport(forged, { pinnedKeyId: "sha256:short" }).reason, "bad_format");
  // A signature made by key B cannot be passed off as key A's, even with A's id and public key in the file.
  const swapped = clone(await sealedExport(2));
  swapped.seal.signature = forged.seal.signature;
  assert.equal(verifyRunExport(swapped).reason, "bad_signature");
});

test("hostile input never throws and never passes", async () => {
  const base = await sealedExport(2);
  const huge = clone(base); huge.steps = Array.from({ length: 100_001 }, () => base.steps[0]);
  for (const bad of [null, undefined, 1, "x", [], {}, { format: EXPORT_FORMAT }, huge,
    { ...clone(base), steps: "no" }, { ...clone(base), steps: [null] }, { ...clone(base), steps: [{}] }, { ...clone(base), seal: {} },
    { ...clone(base), public_key: "***" }, { ...clone(base), header: 5 }, { ...clone(base), key_id: "sha256:zz" }]) {
    const result = verifyRunExport(bad);
    assert.equal(result.ok, false);
    assert.ok(REASONS.includes(result.reason));
  }
  const nonCanonical = clone(base); nonCanonical.steps[0].receipt = ` ${nonCanonical.steps[0].receipt}`; nonCanonical.steps[0].receipt_hash = sha256Hex(nonCanonical.steps[0].receipt);
  assert.equal(verifyRunExport(nonCanonical).ok, false, "re-spaced JSON is not the signed text");
});

// ---- receipt field rules ----
test("actions keep typed text and file contents out, and confidence follows the evidence", () => {
  assert.deepEqual(actionFor({ action: "type", text: "hunter2-secret \u{1F600}", expect: "x" }), { kind: "type", chars: 16, values: [] });
  assert.deepEqual(actionFor({ action: "key", keys: "Control+L", expect: "x" }), { kind: "key", keys: "Control+L" });
  assert.deepEqual(actionFor({ action: "read_document", name: "r.txt", expect: "x" }), { kind: "read_document", name: "r.txt", offset: 0 });
  assert.deepEqual(actionFor({ action: "search_document", name: "r.txt", query: "termination", expect: "x" }), { kind: "search_document", name: "r.txt", chars: 11, hits: 0 });
  assert.deepEqual(actionFor({ action: "extract", name: "headline", value: "Hello world", expect: "x" }), { kind: "extract", name: "headline", chars: 11 });
  assert.deepEqual(actionFor({ action: "search_history", query: "vendor", expect: "x" }), { kind: "search_history", chars: 6, hits: 0 });
  assert.deepEqual(actionFor({ action: "remember", op: "forget", scope: "agent", title: "City", reason: "x" }), { kind: "remember", op: "forget", scope: "agent", chars: 0 });
  assert.deepEqual(actionFor({ action: "navigate", url: "https://a.example/x?q=1", expect: "x" }), { kind: "navigate", host: "a.example" });
  assert.deepEqual(actionFor({ action: "select", target: "Country", option: "Germany", expect: "x" }), { kind: "select", target: "Country", option_chars: 7 });
  assert.equal(actionFor({ action: "finish", summary: "done" }), null);
  const pass = (method) => ({ phase: "verify", method, status: "pass", code: "c" });
  const click = { kind: "click", target: "Go" };
  assert.equal(confidenceFor(click, "pass", [pass("page_structure"), { ...pass("model"), phase: "gate" }]), "high");
  assert.equal(confidenceFor(click, "pass", [pass("page_structure"), { ...pass("page_structure"), phase: "gate" }]), "medium");
  assert.equal(confidenceFor(click, "pass", [pass("page_structure"), { ...pass("model"), status: "fail" }]), "low");
  assert.equal(confidenceFor(click, "blocked", [pass("page_structure")]), "low");
  assert.equal(confidenceFor(click, "unknown", []), "low");
  assert.equal(confidenceFor({ kind: "deliver_file", from: "work", name: "a" }, "executed", []), "none");
  assert.equal(confidenceFor({ kind: "search_document", name: "a", chars: 4, hits: 2 }, "executed", []), "none");
  assert.equal(confidenceFor({ kind: "extract", name: "a", chars: 4 }, "executed", []), "none");
  assert.equal(screenshotHash(undefined), null);
  assert.equal(screenshotHash(PNG), createHash("sha256").update(Buffer.from(PNG, "base64")).digest("hex"));
});

// ---- the step loop writes the receipts ----
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZfJ8AAAAASUVORK5CYII=";
const PNG_AFTER = Buffer.concat([Buffer.from(PNG, "base64"), Buffer.from("after")]).toString("base64");
const usage = { inputTokens: 100, outputTokens: 10, cachedInputTokens: 5, reasoningTokens: 3 };
const step = (args) => ({ id: "r", model: "m", status: "completed", incompleteReason: null, text: "", usage,
  outputs: [{ type: "function_call", callId: "c1", name: "next_step", arguments: JSON.stringify(args) }] });
const fakeProvider = (script) => { let i = 0; return { kind: "meta", requests: [], listModels: async () => [], detectCapabilities: async () => ({}),
  generate: async () => script[Math.min(i++, script.length - 1)] }; };
function fakeDesktop(extra = {}) {
  const calls = []; let shots = 0;
  const desktop = { calls,
    screenshot: async () => { calls.push(["screenshot"]); return { base64: shots++ === 0 ? PNG : PNG_AFTER, width: 1024, height: 768 }; },
    snapshot: async () => { const value = { href: "https://a.example/", title: "A", frames: 0, controls: [{ ref: 1, role: "textbox", name: "Message", tag: "input", x: 100, y: 100, width: 80, height: 30, focused: true }] }; desktop.last = value; return value; },
    click: async (x, y) => { calls.push(["click", x, y]); }, type: async (text) => { calls.push(["type", text]); },
    key: async (key) => { calls.push(["key", key]); }, scroll: async () => { calls.push(["scroll"]); }, ...extra };
  return desktop;
}
async function loop({ script, sink, desktop = fakeDesktop(), verification, ...rest }) {
  const cards = [];
  const deps = { agent: { id: AGENT, name: "Ada", role: "r", soulMd: "s", actions: ["click", "type", "key", "scroll", "wait", "read_document", "deliver_file"] },
    task: "Open the settings page.", model: "muse-spark-1.3", timezone: "UTC", now: () => OWNER_NOW, sleep: async () => {},
    postCard: async (card) => { cards.push(card); }, desktop, provider: fakeProvider(script), receipts: sink,
    approvals: { request: async () => ({ decision: "allow", waitedMs: 0, reason: "allowed_once" }) },
    verification: verification ?? { samState: "off", visual: {
      observe: async (_shot, data) => { const action = JSON.parse(data); const current = desktop.last;
        const control = action.action === "click" ? current && matchControl(current, action.target) : current?.controls.find((c) => c.focused);
        return control ? { status: "pass", name: control.name, role: control.role } : { status: "unknown", name: "", role: "" }; },
      verify: async () => "pass" } }, ...rest };
  return { result: await runTask(deps), cards, desktop };
}
const receiptsOf = (sink) => sink.rows.map((row) => JSON.parse(row.receiptText));

test("each executed step writes one chained receipt; the sealed run verifies and holds no typed text", async () => {
  const sink = memorySink();
  const { result } = await loop({ sink, script: [
    step({ action: "type", text: "hunter2-secret", expect: "text in field" }),
    step({ action: "key", keys: "Enter", expect: "form submitted" }),
    step({ action: "finish", summary: "Submitted the form." }),
  ] });
  assert.equal(result.outcome, "finished");
  assert.equal(sink.rows.length, 2); assert.ok(sink.sealed);
  const [first, second] = receiptsOf(sink);
  assert.deepEqual([first.idx, second.idx, first.v, first.run_id, first.agent_id], [1, 2, 1, RUN_ID, AGENT]);
  assert.deepEqual(first.action, { kind: "type", chars: 14, values: [] });
  assert.deepEqual(second.action, { kind: "key", keys: "Enter" });
  assert.equal(first.result, "pass"); assert.equal(first.confidence, "medium", "a routine type stands on the worker's focus check and the postcondition");
  assert.equal(first.sam, "off"); assert.equal(first.model, "muse-spark-1.3"); assert.equal(first.route, "main");
  assert.equal(first.postcondition, "text in field"); assert.equal(first.cost_micro_usd, null);
  assert.deepEqual(first.target, null);
  assert.equal(first.before_hash, createHash("sha256").update(Buffer.from(PNG, "base64")).digest("hex"));
  assert.ok(/^[0-9a-f]{64}$/.test(first.after_hash) && first.after_hash !== first.before_hash, "after picture hashed");
  assert.ok(first.methods.some((m) => m.phase === "gate" && m.code === "worker_checks_focus") && first.methods.some((m) => m.phase === "verify"));
  assert.equal(sink.rows[0].prevHash, buildHeader({ runId: RUN_ID, agentId: AGENT, agentName: "Ada", task: "Open the settings page.", startedAt: OWNER_NOW.toISOString(), keyId: sink.keys.keyId }).hash);
  assert.equal(sink.rows[1].prevHash, sink.rows[0].receiptHash);
  const exported = sink.export();
  assert.equal(verifyRunExport(exported, { pinnedKeyId: sink.keys.keyId }).ok, true);
  assert.equal(exported.seal.status, "finished");
  assert.ok(!JSON.stringify(exported).includes("hunter2-secret"), "typed text never reaches a receipt");
  // Token usage is attributed to receipts and adds up with what the run reports (the last turn's finish is in the seal).
  const spent = receiptsOf(sink).reduce((sum, r) => sum + r.usage.input, 0);
  assert.ok(spent > 0 && spent <= result.usage.inputTokens);
  assert.equal(exported.seal.usage.input, result.usage.inputTokens);
});

test("a page-structure check takes no picture, so the loop takes one for the after hash", async () => {
  const sink = memorySink();
  const desktop = fakeDesktop({ verify: async () => ({ status: "pass", code: "control_present" }) });
  const { result } = await loop({ sink, desktop, script: [
    step({ action: "type", text: "x", expect: "control_present: Message" }),
    step({ action: "finish", summary: "ok" }),
  ] });
  assert.equal(result.outcome, "finished");
  const [receipt] = receiptsOf(sink);
  assert.equal(receipt.result, "pass");
  assert.ok(receipt.methods.some((m) => m.phase === "verify" && m.method === "page_structure" && m.status === "pass"));
  assert.ok(/^[0-9a-f]{64}$/.test(receipt.after_hash), "an after hash exists even without a visual check");
});

test("a step stopped by the target gate still leaves a blocked receipt and a sealed run", async () => {
  const sink = memorySink();
  const { result, desktop } = await loop({ sink, grounder: { ground: async () => ({ x: 300, y: 200, method: "page_structure" }) },
    script: [step({ action: "click", target: "Submit button", expect: "confirmation" })] });
  assert.equal(result.outcome, "needs_owner");
  assert.deepEqual(desktop.calls.filter(([name]) => !["screenshot", "snapshot"].includes(name)), []);
  const [receipt] = receiptsOf(sink);
  assert.deepEqual([receipt.result, receipt.executed, receipt.confidence, receipt.after_hash], ["blocked", false, "low", null]);
  assert.equal(receipt.action.kind, "click"); assert.equal(sink.export().seal.status, "needs_owner");
  assert.equal(verifyRunExport(sink.export()).ok, true);
});

test("unverified steps record their results and the sixth in a row ends the run needs_owner", async () => {
  const sink = memorySink();
  const verification = { samState: "off", visual: {
    observe: async (_s, data) => ({ status: "pass", name: "Message", role: "textbox", data }), verify: async () => "fail" } };
  const { result } = await loop({ sink, verification, script: [1, 2, 3, 4, 5, 6].map((n) => step({ action: "type", text: "x", expect: `something visible ${n}` })) });
  assert.equal(result.outcome, "needs_owner");
  const receipts = receiptsOf(sink);
  assert.equal(receipts.length, 6);
  for (const receipt of receipts) assert.deepEqual([receipt.result, receipt.executed, receipt.confidence], ["fail", true, "low"]);
});

test("file actions are receipted by name only, with a failed read recorded as failed", async () => {
  const sink = memorySink();
  const desktop = fakeDesktop({
    listFiles: async () => [{ area: "inbox", name: "report.txt", size: 10, kind: "text" }],
    readDocument: async (name) => { if (name === "gone.txt") throw Object.assign(new Error("x"), { code: "file_not_found" }); return { kind: "text", format: "text", truncated: false, text: "TOP SECRET CONTENT", offset: 0, nextOffset: null, totalChars: 18 }; },
    searchDocument: async (name, query) => { assert.equal(query, "termination"); return { format: "pdf", totalChars: 1000, results: [
      { offset: 10, page: 2, text: "TOP SECRET PASSAGE", score: 1 }, { offset: 60, page: 3, text: "second passage", score: 0.5 }] }; },
    deliverFile: async (from, name) => ({ name, size: 5, kind: "text", sha256: "a".repeat(64) }),
  });
  const { result } = await loop({ sink, desktop, script: [
    step({ action: "read_document", name: "report.txt", expect: "read" }),
    step({ action: "read_document", name: "gone.txt", expect: "read" }),
    step({ action: "deliver_file", from: "work", name: "out.txt", expect: "delivered" }),
    step({ action: "search_document", name: "report.pdf", query: "termination", expect: "passages" }),
    step({ action: "finish", summary: "ok" }),
  ] });
  assert.equal(result.outcome, "finished");
  const receipts = receiptsOf(sink);
  assert.deepEqual(receipts.map((r) => [r.idx, r.action.kind, r.result, r.confidence, r.before_hash]), [
    [1, "read_document", "executed", "none", null], [2, "read_document", "failed", "none", null], [3, "deliver_file", "executed", "none", null],
    [4, "search_document", "executed", "none", null]]);
  assert.equal(receipts[1].code, "file_not_found");
  assert.deepEqual(receipts[3].action, { kind: "search_document", name: "report.pdf", chars: 11, hits: 2 });
  assert.ok(!JSON.stringify(sink.export()).includes("TOP SECRET"), "document contents and passages never reach a receipt");
  assert.equal(verifyRunExport(sink.export()).ok, true);
});

test("extract and {{name}} are receipted by name and length only, never the value", async () => {
  const sink = memorySink();
  const desktop = fakeDesktop({ findText: async (text) => ({ found: text === "Hello world", count: 1 }) });
  const { result } = await loop({ sink, desktop, script: [
    step({ action: "extract", name: "headline", value: "Hello world", expect: "saved" }),
    step({ action: "type", text: "Title: {{headline}}", expect: "typed in the field" }),
    step({ action: "finish", summary: "ok" }),
  ] });
  assert.equal(result.outcome, "finished");
  const receipts = receiptsOf(sink);
  assert.deepEqual(receipts[0].action, { kind: "extract", name: "headline", chars: 11 });
  assert.deepEqual(receipts[1].action, { kind: "type", chars: 18, values: ["headline"] });
  assert.deepEqual(receipts.map((receipt) => receipt.confidence), ["none", "medium"]);
  assert.equal(JSON.stringify(sink.export()).includes("Hello world"), false, "the extracted value never reaches a receipt");
  assert.deepEqual(desktop.calls.filter(([name]) => name === "type"), [["type", "Title: Hello world"]]);
});

test("steps with SAM unavailable say so in the receipt", async () => {
  const sink = memorySink();
  const { result } = await loop({ sink, verification: { samState: "unavailable", visual: { observe: async () => ({ status: "pass", name: "Message", role: "textbox" }), verify: async () => "pass" } }, script: [
    step({ action: "type", text: "x", expect: "text" }), step({ action: "finish", summary: "ok" })] });
  assert.equal(result.outcome, "finished");
  assert.equal(receiptsOf(sink)[0].sam, "unavailable");
});

test("no proof, no run: a failed start or a failed receipt write stops the run with a fixed card", async () => {
  const start = memorySink({ failBegin: true });
  const first = await loop({ sink: start, script: [step({ action: "type", text: "x", expect: "y" })] });
  assert.equal(first.result.outcome, "receipt_error");
  assert.deepEqual(first.desktop.calls, [], "nothing touched the desktop");
  assert.equal(first.cards.length, 1); assert.match(first.cards[0].text, /could not record proof/);
  assert.equal(start.sealed, false);

  const middle = memorySink({ failStepAt: 2 });
  const second = await loop({ sink: middle, script: [
    step({ action: "type", text: "a", expect: "y" }), step({ action: "key", keys: "Enter", expect: "y" }),
    step({ action: "key", keys: "Tab", expect: "y" }), step({ action: "finish", summary: "ok" })] });
  assert.equal(second.result.outcome, "receipt_error");
  assert.deepEqual(second.desktop.calls.filter(([n]) => !["screenshot", "snapshot"].includes(n)), [["type", "a"], ["key", "Enter"]], "no input after the failed receipt");
  assert.equal(middle.rows.length, 1);
  assert.equal(middle.export().seal.status, "receipt_error", "the run is sealed with what was recorded");
  assert.equal(verifyRunExport(middle.export()).ok, true);
});

test("a failed seal leaves the run unsealed but still reports the result", async () => {
  const sink = memorySink({ failSeal: true });
  const { result, cards } = await loop({ sink, script: [step({ action: "type", text: "x", expect: "y" }), step({ action: "finish", summary: "Done." })] });
  assert.equal(result.outcome, "finished"); assert.equal(cards.length, 1);
  assert.equal(verifyRunExport(sink.export()).reason, "unsealed");
});

test("a run without a sink still works (callers that claim no proof)", async () => {
  const { result } = await loop({ sink: undefined, script: [step({ action: "type", text: "x", expect: "y" }), step({ action: "finish", summary: "Done." })] });
  assert.equal(result.outcome, "finished");
});

test("npm run receipt-key creates RECEIPT_SIGNING_KEY once, keeps other settings and never prints the value", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "receipt-key-"));
  const envPath = path.join(dir, ".env");
  const printed = [];
  const log = console.log; console.log = (...args) => { printed.push(args.join(" ")); };
  try {
    await writeFile(envPath, "ENCRYPTION_KEY=" + "a".repeat(64) + "\nRECEIPT_SIGNING_KEY=\n");
    await ensureReceiptKey(envPath);
    const after = await readFile(envPath, "utf8");
    const key = /^RECEIPT_SIGNING_KEY=([0-9a-f]{64})$/m.exec(after)?.[1];
    assert.ok(key, "a 64-hex seed was written");
    assert.ok(after.startsWith("ENCRYPTION_KEY=" + "a".repeat(64)), "other settings stay");
    assert.doesNotThrow(() => requireReceiptSigningKey(key));
    assert.ok(printed.length > 0 && printed.every((line) => !line.includes(key)), "the value is never printed");
    await ensureReceiptKey(envPath);
    assert.equal(await readFile(envPath, "utf8"), after, "a second run changes nothing and never rotates the key");
    if (process.platform !== "win32") assert.equal((await stat(envPath)).mode & 0o777, 0o600);
  } finally { console.log = log; await rm(dir, { recursive: true, force: true }); }
});

test("a screen click keeps its point on the receipt and labels clearly in History", async () => {
  const { actionLabel } = await import("../lib/receipts/history-view.ts");
  assert.deepEqual(actionFor({ action: "click_at", x: 7, y: 9, target: "Files", expect: "opens" }), { kind: "click_at", x: 7, y: 9, target: "Files" });
  assert.deepEqual(actionLabel({ kind: "click_at", x: 7, y: 9, target: "Files" }), { text: "Screen click", target: "Files" });
});
