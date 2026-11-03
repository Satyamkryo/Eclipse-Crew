import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { createBlobStore } from "../lib/artifacts/blob-store.ts";
import { loadReceiptSigner } from "../lib/receipts/signer.ts";
import { createReceiptRecorder } from "../lib/receipts/store.ts";
import { createEvidenceRecorder } from "../lib/receipts/evidence.ts";
import { evidenceBelongsToRun, listRuns, loadRunDetail } from "../lib/receipts/history.ts";
import { actionLabel, methodLabel, summarizeRun, viewStep } from "../lib/receipts/history-view.ts";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const BEFORE = Buffer.from("before-png-bytes");
const AFTER = Buffer.from("after-png-bytes");

// ---- pure view helpers ----

const receipt = (extra = {}) => JSON.stringify({
  idx: 1, model: "muse-spark-1.3", model_label: "muse-spark-1.3", route: "main", action: { kind: "click", target: "Download PDF" },
  target: { role: "button", name: "Download PDF" }, grounding_method: "page_structure", methods: [{ phase: "verify", method: "sam", status: "pass", code: "unique_mask" }],
  sam: "on", confidence: "high", before_hash: sha(BEFORE), after_hash: sha(AFTER), postcondition: "object_visible: Download PDF", result: "pass", code: null,
  executed: true, usage: { input: 1, output: 1, cached: 0, reasoning: 0 }, cost_micro_usd: 8000, ...extra,
});

test("a step view shows the action, method and SAM state, and cost in micro-USD", () => {
  const view = viewStep(receipt(), "a".repeat(64), "b".repeat(64), 1, null);
  assert.deepEqual([view.action, view.target, view.method, view.result, view.tone, view.confidence, view.costMicroUsd], ["Click", "Download PDF", "SAM 3.1", "pass", "success", "high", 8000]);
  const off = viewStep(receipt({ sam: "off", methods: [{ phase: "verify", method: "page_structure", status: "pass", code: "ok" }] }), "a".repeat(64), "b".repeat(64), 1, null);
  assert.equal(off.method, "Page structure (SAM off)");
  assert.equal(methodLabel([], "unavailable", "wait"), "No check passed (SAM unavailable)");
  assert.equal(methodLabel([], "off", "read_document"), "File action, no screen check");
  assert.deepEqual(actionLabel({ kind: "search_document", name: "report.pdf", chars: 11, hits: 2 }), { text: "Searched document", target: "report.pdf" });
  assert.equal(methodLabel([], "off", "search_document"), "File action, no screen check");
});

test("typed text is only ever a character count in a step view", () => {
  assert.equal(actionLabel({ kind: "type", chars: 12 }).text, "Type 12 characters");
  const view = viewStep(receipt({ action: { kind: "type", chars: 12, text: "hunter2" } }), "a".repeat(64), "b".repeat(64), 1, null);
  assert.equal(JSON.stringify(view).includes("hunter2"), false);
});

test("images are shown only when the stored file matches the signed hash; the outline only on the after image", () => {
  const box = { x1: 10, y1: 20, x2: 110, y2: 60, width: 1024, height: 768 };
  const stored = { beforeHash: sha(BEFORE), afterHash: sha(AFTER), width: 1024, height: 768, samBox: box };
  const view = viewStep(receipt(), "a".repeat(64), "b".repeat(64), 1, stored);
  assert.deepEqual([view.beforeImage, view.afterImage, view.screens, view.samBox], [sha(BEFORE), sha(AFTER), "stored", box]);

  const swapped = viewStep(receipt(), "a".repeat(64), "b".repeat(64), 1, { ...stored, afterHash: "f".repeat(64) });
  assert.deepEqual([swapped.beforeImage, swapped.afterImage, swapped.samBox], [sha(BEFORE), null, null], "a different file is never shown, and no outline floats without its image");

  assert.equal(viewStep(receipt(), "a".repeat(64), "b".repeat(64), 1, null).screens, "missing");
  assert.equal(viewStep(receipt({ before_hash: null, after_hash: null }), "a".repeat(64), "b".repeat(64), 1, null).screens, "none");
  const badBox = viewStep(receipt(), "a".repeat(64), "b".repeat(64), 1, { ...stored, samBox: { x1: -5, y1: "x" } });
  assert.equal(badBox.samBox, null, "a malformed stored box is ignored");
});

test("a damaged stored receipt becomes a placeholder row instead of breaking the timeline", () => {
  for (const text of ["not json", "{}", JSON.stringify({ idx: 1, action: { kind: 5 } })]) {
    const view = viewStep(text, "a".repeat(64), "b".repeat(64), 7, null);
    assert.deepEqual([view.idx, view.action, view.tone], [7, "Step could not be read", "warning"]);
  }
});

test("run summaries: verified, running, not sealed, stopped", () => {
  const base = { runId: randomUUID(), headerText: JSON.stringify({ task: "Collect invoices" }), startedAt: new Date("2026-11-02T10:00:00Z"), now: new Date("2026-11-02T10:01:00Z") };
  const done = summarizeRun({ ...base, endedAt: new Date("2026-11-02T10:00:30Z"), sealed: true, status: "finished", stepResults: ["pass", "executed"] });
  assert.deepEqual([done.label, done.tone, done.verified, done.durationMs, done.task], ["Verified", "success", true, 30000, "Collect invoices"]);
  assert.equal(summarizeRun({ ...base, endedAt: null, sealed: false, status: "running", stepResults: [] }).label, "Running");
  assert.equal(summarizeRun({ ...base, now: new Date("2026-11-02T11:00:00Z"), endedAt: null, sealed: false, status: "running", stepResults: [] }).label, "Not sealed");
  const stopped = summarizeRun({ ...base, endedAt: new Date(), sealed: true, status: "step_limit", stepResults: ["pass"] });
  assert.deepEqual([stopped.label, stopped.tone, stopped.verified], ["Stopped", "danger", false]);
  const finishedWithFailure = summarizeRun({ ...base, endedAt: new Date(), sealed: true, status: "finished", stepResults: ["pass", "fail"] });
  assert.deepEqual([finishedWithFailure.label, finishedWithFailure.verified], ["Finished", false]);
  assert.equal(summarizeRun({ ...base, headerText: "garbage", endedAt: null, sealed: false, status: "running", stepResults: [] }).task, "");
});

// ---- stored runs, against a throwaway Postgres with the 0009 and 0010 tables and the production grants ----

const docker = (args, input) => spawnSync("docker", args, { encoding: "utf8", input, timeout: 120000 });
const dockerUp = docker(["version", "--format", "{{.Server.Version}}"]).status === 0;
const name = `eclipse-history-${randomBytes(6).toString("hex")}`;
const password = randomBytes(16).toString("hex");
const OWNER = randomUUID(); const OTHER_OWNER = randomUUID(); const AGENT = randomUUID();
const SEED = randomBytes(32).toString("hex");
let adminPool; let appPool; let app; let blobRoot; let blobs;

test.before(async () => {
  blobRoot = await mkdtemp(path.join(tmpdir(), "eclipse-history-"));
  blobs = createBlobStore(blobRoot);
  if (!dockerUp) return;
  const started = docker(["run", "-d", "--name", name, "-e", `POSTGRES_PASSWORD=${password}`, "-p", "127.0.0.1::5432",
    "postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b"]);
  assert.equal(started.status, 0, started.stderr);
  for (let i = 0; i < 40; i++) {
    if (docker(["exec", name, "pg_isready", "-U", "postgres", "-h", "127.0.0.1"]).status === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const port = Number(docker(["port", name, "5432/tcp"]).stdout.trim().split(":").pop());
  for (let i = 0; i < 40 && !adminPool; i++) {
    const candidate = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", password, database: "postgres" });
    try { await candidate.query("select 1"); adminPool = candidate; } catch { await candidate.end().catch(() => {}); await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
  assert.ok(adminPool, "database became reachable");
  for (const file of ["0009_receipts_runs_steps.sql", "0010_curly_ultimo.sql", "0012_quick_molten_man.sql"]) {
    await adminPool.query(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  await adminPool.query(`ALTER TABLE runs ADD COLUMN heartbeat_at timestamptz, ADD COLUMN cancel_requested_at timestamptz;`);
  await adminPool.query(`CREATE ROLE app_role LOGIN PASSWORD '${password}'; GRANT SELECT, INSERT, UPDATE ON runs TO app_role; GRANT SELECT, INSERT ON steps TO app_role; GRANT SELECT, INSERT ON step_evidence TO app_role; GRANT SELECT, INSERT ON checkpoints TO app_role;`);
  appPool = new pg.Pool({ host: "127.0.0.1", port, user: "app_role", password, database: "postgres" });
  app = drizzle({ client: appPool });
});
test.after(async () => {
  await appPool?.end().catch(() => {}); await adminPool?.end().catch(() => {});
  if (dockerUp) docker(["rm", "-f", name]);
  if (blobRoot) await rm(blobRoot, { recursive: true, force: true });
});

const shot = (bytes) => ({ base64: bytes.toString("base64"), width: 1024, height: 768 });
const stepInput = (idx, extra = {}) => ({ idx, model: "m", model_label: "m", route: "main", action: { kind: "click", target: `Button ${idx}` }, target: { role: "button", name: `Button ${idx}` },
  grounding_method: "page_structure", methods: [{ phase: "verify", method: "page_structure", status: "pass", code: "ok" }], sam: "off", confidence: "medium",
  before_hash: sha(BEFORE), after_hash: sha(AFTER), postcondition: `expect ${idx}`, result: "pass", code: null, executed: true,
  usage: { input: 1, output: 1, cached: 0, reasoning: 0 }, cost_micro_usd: null, ...extra });

async function recordedRun({ owner = OWNER, seal = true, steps = 2, withEvidence = true, samBox = null } = {}) {
  const receipts = createReceiptRecorder({ database: app, ownerId: owner, agentId: AGENT, agentName: "Ada", task: "Collect monthly invoices.", signer: loadReceiptSigner(SEED) });
  const evidence = createEvidenceRecorder({ database: app, ownerId: owner, runId: receipts.runId, blobs });
  await receipts.begin();
  for (let idx = 1; idx <= steps; idx++) {
    await receipts.step(stepInput(idx));
    if (withEvidence) await evidence.record({ idx, before: shot(BEFORE), after: shot(AFTER), samBox: idx === steps ? samBox : null });
  }
  if (seal) await receipts.seal("finished", { input: steps, output: steps, cached: 0, reasoning: 0 });
  return receipts.runId;
}

test("evidence stores each screenshot once under its own hash and links it to the step", { skip: !dockerUp && "Docker is not available" }, async () => {
  const box = { x1: 10, y1: 20, x2: 110, y2: 60, width: 1024, height: 768 };
  const runId = await recordedRun({ steps: 2, samBox: box });
  const rows = (await adminPool.query("select idx, before_hash, after_hash, width, height, sam_box from step_evidence where run_id = $1 order by idx", [runId])).rows;
  assert.deepEqual(rows.map((row) => [row.idx, row.before_hash, row.after_hash, row.width, row.height]), [[1, sha(BEFORE), sha(AFTER), 1024, 768], [2, sha(BEFORE), sha(AFTER), 1024, 768]]);
  assert.deepEqual([rows[0].sam_box, rows[1].sam_box], [null, box]);
  assert.deepEqual(await blobs.get(sha(BEFORE)), BEFORE);
  assert.deepEqual(await blobs.get(sha(AFTER)), AFTER);
});

test("file steps without screenshots get no evidence row", { skip: !dockerUp && "Docker is not available" }, async () => {
  const receipts = createReceiptRecorder({ database: app, ownerId: OWNER, agentId: AGENT, agentName: "Ada", task: "t", signer: loadReceiptSigner(SEED) });
  const evidence = createEvidenceRecorder({ database: app, ownerId: OWNER, runId: receipts.runId, blobs });
  await receipts.begin();
  await receipts.step(stepInput(1, { action: { kind: "read_document", name: "a.txt", offset: 0 }, before_hash: null, after_hash: null }));
  await evidence.record({ idx: 1, before: null, after: null, samBox: null });
  assert.equal((await adminPool.query("select count(*)::int as n from step_evidence where run_id = $1", [receipts.runId])).rows[0].n, 0);
});

test("run detail verifies the chain, lists steps with their images, and the list is scoped to the owner and agent", { skip: !dockerUp && "Docker is not available" }, async () => {
  const runId = await recordedRun({ steps: 3 });
  const detail = await loadRunDetail(app, OWNER, runId);
  assert.deepEqual(detail.chain, { state: "verified" });
  assert.deepEqual([detail.run.label, detail.run.task, detail.run.stepCount, detail.run.verified], ["Verified", "Collect monthly invoices.", 3, true]);
  assert.deepEqual(detail.steps.map((step) => [step.idx, step.screens, step.beforeImage, step.afterImage]), [1, 2, 3].map((idx) => [idx, "stored", sha(BEFORE), sha(AFTER)]));

  assert.ok((await listRuns(app, OWNER, AGENT)).some((run) => run.runId === runId));
  assert.equal((await listRuns(app, OTHER_OWNER, AGENT)).length, 0, "another owner sees no runs");
  assert.equal((await listRuns(app, OWNER, randomUUID())).length, 0, "another agent has no runs");
  assert.equal(await loadRunDetail(app, OTHER_OWNER, runId), null);
  assert.equal(await loadRunDetail(app, OWNER, randomUUID()), null);
});

test("editing a stored receipt fails the chain badge with the reason and step; unsealed runs say so", { skip: !dockerUp && "Docker is not available" }, async () => {
  const runId = await recordedRun({ steps: 3 });
  await adminPool.query("update steps set receipt_json = replace(receipt_json, 'expect 2', 'expect X') where run_id = $1 and idx = 2", [runId]);
  const detail = await loadRunDetail(app, OWNER, runId);
  assert.deepEqual(detail.chain, { state: "failed", reason: "receipt_hash_mismatch", step: 2 });

  const open = await recordedRun({ steps: 1, seal: false });
  const unsealed = await loadRunDetail(app, OWNER, open);
  assert.deepEqual([unsealed.chain.state, unsealed.run.label], ["unsealed", "Running"]);
});

test("each step says whether a full checkpoint was saved after it", { skip: !dockerUp && "Docker is not available" }, async () => {
  const runId = await recordedRun({ steps: 3 });
  const row = (idx, status, reason) => adminPool.query("insert into checkpoints(id, owner_id, run_id, idx, state_hash, manifest_hash, status, reason) values ($1, $2, $3, $4, $5, $6, $7, $8)",
    [randomUUID(), OWNER, runId, idx, "a".repeat(64), status === "complete" ? "b".repeat(64) : null, status, reason]);
  await row(1, "complete", null); await row(2, "partial", "files_unreadable");
  const detail = await loadRunDetail(app, OWNER, runId);
  assert.deepEqual(detail.steps.map((step) => [step.idx, step.checkpoint, step.checkpointReason]), [[1, "saved", null], [2, "partial", "files_unreadable"], [3, "missing", null]]);
});

test("a run without stored evidence shows 'missing' screenshots and no image hashes", { skip: !dockerUp && "Docker is not available" }, async () => {
  const runId = await recordedRun({ steps: 1, withEvidence: false });
  const detail = await loadRunDetail(app, OWNER, runId);
  assert.deepEqual([detail.steps[0].screens, detail.steps[0].beforeImage, detail.steps[0].afterImage], ["missing", null, null]);
  assert.equal(await evidenceBelongsToRun(app, OWNER, runId, sha(BEFORE)), false);
});

test("only hashes listed as evidence of the owner's own run may be served", { skip: !dockerUp && "Docker is not available" }, async () => {
  const runId = await recordedRun({ steps: 1 });
  assert.equal(await evidenceBelongsToRun(app, OWNER, runId, sha(BEFORE)), true);
  assert.equal(await evidenceBelongsToRun(app, OWNER, runId, sha(AFTER)), true);
  assert.equal(await evidenceBelongsToRun(app, OWNER, runId, sha(Buffer.from("other"))), false, "a hash that is not part of this run");
  assert.equal(await evidenceBelongsToRun(app, OTHER_OWNER, runId, sha(BEFORE)), false, "another owner");
  const elsewhere = await recordedRun({ steps: 1 });
  assert.equal(await evidenceBelongsToRun(app, OWNER, elsewhere, sha("x")), false);
});

test("the app role can add and read evidence but never rewrite or delete it", { skip: !dockerUp && "Docker is not available" }, async () => {
  const runId = await recordedRun({ steps: 1 });
  await assert.rejects(() => appPool.query("update step_evidence set sam_box = null where run_id = $1", [runId]), /permission denied/);
  await assert.rejects(() => appPool.query("delete from step_evidence where run_id = $1", [runId]), /permission denied/);
  await assert.rejects(() => appPool.query("insert into step_evidence(id, owner_id, run_id, idx) values ($1, $2, $3, 1)", [randomUUID(), OWNER, runId]), /duplicate|unique/);
});
