import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import { buildHeader, canonicalJson, sha256Hex } from "../lib/receipts/chain.mjs";
import { summarizeRun } from "../lib/receipts/history-view.ts";
import { correctionTask } from "../lib/rewind/branch.ts";
import { MAX_REWIND_BYTES, MAX_REWIND_OPERATIONS, planRestore } from "../lib/rewind/plan.ts";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const RUN = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const KEY = `sha256:${"a".repeat(64)}`;
const entry = (area, path, content = path) => {
  const bytes = Buffer.from(content);
  return { area, path, size: bytes.length, sha256: sha(bytes), restorable: true };
};
const big = (area, path, size) => ({ area, path, size, sha256: null, restorable: false });

// ---- plan ----

test("unchanged files are kept, missing or changed files are put, and later files are moved aside", () => {
  const saved = [entry("work", "a.txt", "alpha"), entry("inbox", "report.csv", "1,2")];
  const current = [entry("work", "a.txt", "alpha"), entry("work", "later.txt", "later")];
  const result = planRestore(saved, current);
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.kept, 1);
  assert.deepEqual(result.plan.put.map((item) => `${item.area}/${item.path}`), ["inbox/report.csv"]);
  assert.deepEqual(result.plan.aside.map((item) => `${item.area}/${item.path}`), ["work/later.txt"]);
  assert.equal(result.plan.bytes, 3);
});

test("a changed file is put back and an unchanged live file is not touched", () => {
  const result = planRestore([entry("work", "a.txt", "alpha")], [entry("work", "a.txt", "beta"), entry("work", "same.txt", "same")]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.put.map((item) => item.sha256), [sha("alpha")]);
  assert.deepEqual(result.plan.aside.map((item) => item.path), ["same.txt"]);
});

test("a file over the restorable limit is kept by size, or refused when missing or resized", () => {
  const saved = [big("downloads", "movie.mp4", 5 * 1024 * 1024)];
  const kept = planRestore(saved, [{ area: "downloads", path: "movie.mp4", size: 5 * 1024 * 1024, sha256: null, restorable: false }]);
  assert.equal(kept.ok, true);
  assert.equal(kept.plan.kept, 1);
  assert.deepEqual(planRestore(saved, []), { ok: false, reason: "file_not_restorable" });
  assert.deepEqual(planRestore(saved, [{ area: "downloads", path: "movie.mp4", size: 6 * 1024 * 1024, sha256: null, restorable: false }]),
    { ok: false, reason: "file_not_restorable" });
});

test("a live oversized file is overwritten when the checkpoint has restorable bytes", () => {
  const result = planRestore([entry("work", "a.txt", "alpha")], [big("work", "a.txt", 5 * 1024 * 1024)]);
  assert.equal(result.ok, true);
  assert.equal(result.plan.put.length, 1);
});

test("ambiguous or invalid checkpoint entries are refused", () => {
  assert.deepEqual(planRestore([entry("work", "a.txt", "a"), entry("work", "a.txt", "b")], []), { ok: false, reason: "checkpoint_incomplete" });
  assert.deepEqual(planRestore([{ area: "work", path: "a.txt", size: 1, sha256: null, restorable: true }], []), { ok: false, reason: "checkpoint_incomplete" });
});

test("the operation and byte caps refuse a plan instead of partially restoring it", () => {
  const saved = Array.from({ length: 3 }, (_, index) => entry("work", `f${index}.txt`, `v${index}`));
  assert.deepEqual(planRestore(saved, [], { maxOperations: 2 }), { ok: false, reason: "too_many_changes" });
  assert.deepEqual(planRestore(saved, [], { maxBytes: 1 }), { ok: false, reason: "too_many_changes" });
  assert.equal(MAX_REWIND_OPERATIONS, 200);
  assert.equal(MAX_REWIND_BYTES, 64 * 1024 * 1024);
});

test("the plan is deterministic and sorted", () => {
  const saved = [entry("work", "z.txt", "z"), entry("inbox", "b.txt", "b"), entry("work", "a.txt", "a")];
  const first = planRestore(saved, []);
  const second = planRestore([...saved].reverse(), []);
  assert.deepEqual(first, second);
  assert.deepEqual(first.plan.put.map((item) => `${item.area}/${item.path}`), ["inbox/b.txt", "work/a.txt", "work/z.txt"]);
});

// ---- correction ----

test("the correction survives and the original task is trimmed at 2,000 characters", () => {
  const correction = "Check every invoice date before downloading. ".repeat(20).slice(0, 600);
  const combined = correctionTask("a".repeat(1900), correction);
  assert.equal([...combined].length, 2000);
  assert.ok(combined.endsWith(`Owner correction: ${correction}`));
  assert.ok(combined.startsWith("a"));
});

test("a short task keeps the correction exactly", () => {
  assert.equal(correctionTask("Collect invoices.", "Ignore April."), "Collect invoices.\n\nOwner correction: Ignore April.");
});

// ---- signed header ----

test("an ordinary header is byte-identical to the pre-branch format", () => {
  const input = { runId: RUN, agentId: AGENT, agentName: "Ada", task: "Collect invoices.", startedAt: "2026-11-02T10:00:00.000Z", keyId: KEY };
  const plain = buildHeader(input);
  const expected = canonicalJson({ v: 1, run_id: RUN, agent_id: AGENT, agent_name: "Ada", task: "Collect invoices.", started_at: input.startedAt, key_id: KEY });
  assert.equal(plain.text, expected);
  assert.equal(plain.hash, sha256Hex(expected));
  assert.equal(plain.text.includes("branch_"), false);
});

test("a branch header signs the original run and checkpoint", () => {
  const original = "33333333-3333-4333-8333-333333333333";
  const plain = buildHeader({ runId: RUN, agentId: AGENT, agentName: "Ada", task: "t", startedAt: "2026-11-02T10:00:00.000Z", keyId: KEY });
  const branch = buildHeader({ runId: RUN, agentId: AGENT, agentName: "Ada", task: "t", startedAt: "2026-11-02T10:00:00.000Z", keyId: KEY, branchOf: original, branchAt: 3 });
  assert.equal(branch.text, canonicalJson({ v: 1, run_id: RUN, agent_id: AGENT, agent_name: "Ada", task: "t", started_at: "2026-11-02T10:00:00.000Z", key_id: KEY, branch_of: original, branch_at: 3 }));
  assert.notEqual(branch.hash, plain.hash);
  assert.throws(() => buildHeader({ runId: RUN, agentId: AGENT, agentName: "A", task: "t", startedAt: "2026-11-02T10:00:00.000Z", keyId: KEY, branchOf: "nope", branchAt: 1 }), TypeError);
  assert.throws(() => buildHeader({ runId: RUN, agentId: AGENT, agentName: "A", task: "t", startedAt: "2026-11-02T10:00:00.000Z", keyId: KEY, branchOf: original, branchAt: -1 }), TypeError);
});

test("the rewind route is POST-only and refuses anonymous requests with safe headers", async () => {
  const route = await import("../app/api/runs/[runId]/rewind/route.ts");
  assert.equal(typeof route.POST, "function");
  for (const method of ["GET", "PUT", "PATCH", "DELETE"]) assert.equal(route[method], undefined, method);
  const runId = randomUUID();
  const response = await route.POST(new Request(`http://127.0.0.1:3000/api/runs/${runId}/rewind`, { method: "POST" }),
    { params: Promise.resolve({ runId }) });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
});

test("History reads the branch fields from the signed header only", () => {
  const base = { startedAt: new Date("2026-11-02T10:00:00Z"), endedAt: new Date("2026-11-02T10:01:00Z"), sealed: true, status: "finished", stepResults: ["pass"], now: new Date("2026-11-02T10:02:00Z") };
  const original = randomUUID();
  const branch = summarizeRun({ ...base, runId: RUN, headerText: JSON.stringify({ task: "t", branch_of: original, branch_at: 2 }) });
  assert.deepEqual(branch.branch, { runId: original, step: 2 });
  assert.equal(summarizeRun({ ...base, runId: RUN, headerText: JSON.stringify({ task: "t" }) }).branch, null);
  assert.equal(summarizeRun({ ...base, runId: RUN, headerText: JSON.stringify({ task: "t", branch_of: "nope", branch_at: 2 }) }).branch, null);
});
