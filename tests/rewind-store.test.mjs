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

import { claimAgent } from "../lib/agent/step-loop.ts";
import { createBlobStore } from "../lib/artifacts/blob-store.ts";
import { createCheckpointRecorder } from "../lib/checkpoints/store.ts";
import { verifyRunExport } from "../lib/receipts/chain.mjs";
import { loadRunDetail } from "../lib/receipts/history.ts";
import { loadReceiptSigner } from "../lib/receipts/signer.ts";
import { createReceiptRecorder, loadRunExport } from "../lib/receipts/store.ts";
import { startBranch } from "../lib/rewind/branch.ts";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZfJ8AAAAASUVORK5CYII=";
const sealUsage = { input: 1, output: 1, cached: 0, reasoning: 0 };
const OWNER = randomUUID(); const OTHER_OWNER = randomUUID(); const AGENT = randomUUID();
const SEED = randomBytes(32).toString("hex");
const signer = loadReceiptSigner(SEED);

const docker = (args) => spawnSync("docker", args, { encoding: "utf8", timeout: 120000 });
const dockerUp = docker(["version", "--format", "{{.Server.Version}}"]).status === 0;
const name = `eclipse-rewind-${randomBytes(6).toString("hex")}`;
const password = randomBytes(16).toString("hex");
let adminPool; let appPool; let app; let root; let blobs;

test.before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "eclipse-rewind-"));
  blobs = createBlobStore(root);
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
  for (const file of ["0009_receipts_runs_steps.sql", "0010_curly_ultimo.sql", "0012_quick_molten_man.sql"])
    await adminPool.query(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""));
  await adminPool.query(`CREATE ROLE app_role LOGIN PASSWORD '${password}'; GRANT SELECT, INSERT, UPDATE ON runs TO app_role; GRANT SELECT, INSERT ON steps TO app_role; GRANT SELECT, INSERT ON step_evidence TO app_role; GRANT SELECT, INSERT ON checkpoints TO app_role;`);
  appPool = new pg.Pool({ host: "127.0.0.1", port, user: "app_role", password, database: "postgres" });
  app = drizzle({ client: appPool });
});
test.after(async () => {
  await appPool?.end().catch(() => {}); await adminPool?.end().catch(() => {});
  if (dockerUp) docker(["rm", "-f", name]);
  if (root) await rm(root, { recursive: true, force: true });
});

const skip = !dockerUp && "Docker is not available";
const receiptInput = (idx) => ({
  idx, model: "mock", model_label: "mock", route: "main", action: { kind: "click", target: "Invoices" },
  target: { role: "button", name: "Invoices" }, grounding_method: "page_structure", methods: [], sam: "off", confidence: "low",
  before_hash: null, after_hash: null, postcondition: "url_path: /invoices", result: "executed", code: null, executed: true,
  usage: { input: 1, output: 1, cached: 0, reasoning: 0 }, cost_micro_usd: null,
});
async function makeRun({ owner = OWNER, seal = true, steps = 2 } = {}) {
  const recorder = createReceiptRecorder({ database: app, ownerId: owner, agentId: AGENT, agentName: "Ada", task: "Collect invoices.", signer });
  await recorder.begin();
  for (let idx = 1; idx <= steps; idx++) await recorder.step(receiptInput(idx));
  if (seal) await recorder.seal("needs_owner", sealUsage);
  return recorder.runId;
}

const entryOf = (key, bytes) => {
  const [area, ...rest] = key.split("/");
  return bytes.length > 4 * 1024 * 1024
    ? { area, path: rest.join("/"), size: bytes.length, sha256: null, restorable: false }
    : { area, path: rest.join("/"), size: bytes.length, sha256: sha(bytes), restorable: true };
};
function checkpointDesktop(files, { failManifest = false } = {}) {
  const map = new Map(Object.entries(files).map(([key, value]) => [key, Buffer.from(value)]));
  return {
    async checkpointManifest() {
      if (failManifest) throw Object.assign(new Error("scan_failed"), { code: "scan_failed" });
      return { entries: [...map].map(([key, value]) => entryOf(key, value)), skipped: 0 };
    },
    async checkpointBlob({ area, path: rel }) {
      const value = map.get(`${area}/${rel}`);
      if (!value) throw Object.assign(new Error("file_not_found"), { code: "file_not_found" });
      return value;
    },
  };
}
const snapshotAt = (idx, extra = {}) => ({
  task: "Collect invoices.", turn: idx, receiptIdx: idx,
  history: idx ? [{ step: idx, action: "click", target: "Invoices", expect: "url_path: /invoices", result: "executed" }] : [],
  documents: [], delivered: [], counters: { invalid: 0, repeats: 0, misses: 0, hardTurns: 0, hardDisabled: false },
  previous: null, usage: { input: 0, output: 0, cached: 0, reasoning: 0 }, ...extra,
});
async function capture(runId, idx, files, { failManifest = false, state = {} } = {}) {
  const recorder = createCheckpointRecorder({ database: app, ownerId: OWNER, runId, desktop: checkpointDesktop(files, { failManifest }), blobs });
  await recorder.capture(idx, snapshotAt(idx, state));
}

function restoreDesktop(initial, options = { failAt: 0 }) {
  const files = new Map(Object.entries(initial).map(([key, value]) => [key, Buffer.from(value)]));
  const puts = []; const asides = []; let putCount = 0;
  return {
    files, puts, asides, options,
    async checkpointManifest() { return { entries: [...files].map(([key, value]) => entryOf(key, value)), skipped: 0 }; },
    async checkpointPut(file, bytes) {
      putCount += 1;
      if (options.failAt && putCount === options.failAt) throw Object.assign(new Error("target_blocked"), { code: "target_blocked" });
      puts.push(file);
      files.set(`${file.area}/${file.path}`, Buffer.from(bytes));
    },
    async checkpointAside({ area, path: rel, bucket }) { asides.push({ area, path: rel, bucket }); files.delete(`${area}/${rel}`); },
    screenshot: async () => ({ base64: PNG, width: 1024, height: 768 }),
    snapshot: async () => ({ href: "https://example.test/", title: "Invoices", frames: 0, controls: [] }),
    click: async () => {}, type: async () => {}, key: async () => {}, scroll: async () => {},
    readDocument: async (name, offset) => ({ kind: "text", format: "text", truncated: false, text: "Document.", offset, nextOffset: null, totalChars: 9 }),
  };
}

function makePorts(desktop, prepareOverride) {
  let resolveDone; const done = new Promise((resolve) => { resolveDone = resolve; });
  const state = { options: null, deps: null, cards: [], runCalls: 0, prepareCalls: 0, done };
  const ports = {
    async prepare(ownerId, agentId, options) {
      state.prepareCalls += 1; state.options = options;
      if (prepareOverride) return prepareOverride(ownerId, agentId, options);
      const runId = randomUUID();
      return { ok: true, persona: { id: AGENT, name: "Ada", role: "R", soulMd: "", actions: [] }, timezone: "UTC", model: "mock", hardModel: null,
        provider: { kind: "meta", generate: async () => { throw new Error("the model must not run in these tests"); }, listModels: async () => [], detectCapabilities: async () => ({}) },
        desktop,
        receipts: (task) => createReceiptRecorder({ database: app, ownerId, agentId, agentName: "Ada", task, signer, runId,
          ...(options?.branch ? { branch: options.branch } : {}) }) };
    },
    async postCard(ownerId, agentId, card, runId) { state.cards.push({ card, runId }); },
    async run(deps) {
      state.runCalls += 1; state.deps = deps;
      try {
        await deps.receipts.begin();
        deps.onStarted?.();
        await deps.receipts.step(receiptInput(1));
        await deps.receipts.seal("finished", sealUsage);
      } finally {
        deps.claimed?.();
        resolveDone();
      }
      return { outcome: "finished", cardPosted: true };
    },
  };
  return { ports, state };
}

const runCount = async () => (await adminPool.query("select count(*)::int as count from runs")).rows[0].count;
async function expectRefusal(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, "RewindError");
    assert.equal(error.code, code);
    return true;
  });
}
const assertLockFree = () => { const release = claimAgent(AGENT); assert.ok(release, "the agent lock was released"); release(); };
const start = (runId, step, ports, extra = {}) => startBranch({
  database: app, ownerId: OWNER, runId, step, correction: "Check the March dates.", ports: ports.ports, blobs,
  status: async () => ({ state: "running", takenOver: false }), ...extra,
});

test("a branch restores files, keeps the original proofs and records a signed branch header", { skip }, async () => {
  const runId = await makeRun();
  await capture(runId, 1, { "work/a.txt": "alpha", "inbox/r.csv": "1,2" }, {
    state: { documents: [{ name: "report.pdf", window: { kind: "text", offset: 100 } }], delivered: ["invoice.pdf"] },
  });
  const before = await loadRunExport(app, OWNER, runId);
  const desktop = restoreDesktop({ "work/a.txt": "alpha", "work/later.txt": "later" });
  const ports = makePorts(desktop);
  const result = await start(runId, 1, ports).then(async (value) => { await ports.state.done; return value; });

  assert.notEqual(result.runId, runId);
  assert.deepEqual(result.restored, { put: 1, aside: 1, kept: 1 });
  assert.deepEqual(ports.state.options.branch, { runId, step: 1 });
  assert.deepEqual(desktop.puts.map((item) => `${item.area}/${item.path}`), ["inbox/r.csv"]);
  assert.deepEqual(desktop.asides, [{ area: "work", path: "later.txt", bucket: result.runId }]);
  assert.equal(desktop.files.has("inbox/r.csv"), true);
  assert.equal(desktop.files.has("work/later.txt"), false);
  assert.equal(ports.state.cards.length, 1);
  assert.match(ports.state.cards[0].card.text, /^Rewound to step 1 of run/);
  assert.equal(ports.state.cards[0].runId, result.runId);
  assert.equal(ports.state.deps.resume.turn, 1);
  assert.deepEqual(ports.state.deps.resume.documents, [{ name: "report.pdf", offset: 100 }]);
  assert.deepEqual(ports.state.deps.resume.delivered, ["invoice.pdf"]);
  assert.match(ports.state.deps.task, /Owner correction: Check the March dates\./);

  const row = (await adminPool.query("select branch_of from runs where id = $1", [result.runId])).rows[0];
  assert.equal(row.branch_of, runId);
  const branchExport = await loadRunExport(app, OWNER, result.runId);
  assert.equal(verifyRunExport(branchExport).ok, true);
  const header = JSON.parse(branchExport.header);
  assert.equal(header.branch_of, runId);
  assert.equal(header.branch_at, 1);
  assert.match(header.task, /Check the March dates/);
  const after = await loadRunExport(app, OWNER, runId);
  assert.deepEqual(after, before, "the original run's header and receipts are untouched");
  assert.equal(verifyRunExport(after).ok, true);

  const original = await loadRunDetail(app, OWNER, runId);
  assert.equal(original.run.branch, null);
  assert.deepEqual(original.branches.map((item) => item.runId), [result.runId]);
  const branch = await loadRunDetail(app, OWNER, result.runId);
  assert.deepEqual(branch.run.branch, { runId, step: 1 });
});

test("refusals change nothing: partial, unsealed, out of range, other owner and unknown", { skip }, async () => {
  const runId = await makeRun();
  await capture(runId, 1, { "work/a.txt": "alpha" });
  const before = await runCount();
  for (const [code, make] of [
    ["step_out_of_range", () => start(runId, 3, makePorts(restoreDesktop({})))],
    ["run_not_found", () => start(randomUUID(), 1, makePorts(restoreDesktop({})))],
    ["run_not_found", () => startBranch({ database: app, ownerId: OTHER_OWNER, runId, step: 1, correction: "x", ports: makePorts(restoreDesktop({})).ports, blobs,
      status: async () => ({ state: "running" }) })],
  ]) {
    await expectRefusal(make(), code);
    assert.equal(await runCount(), before, `${code} creates no run`);
  }

  const unsealed = await makeRun({ seal: false });
  await capture(unsealed, 0, {});
  await expectRefusal(start(unsealed, 0, makePorts(restoreDesktop({}))), "run_not_rewindable");

  const partial = await makeRun();
  await capture(partial, 0, { "work/a.txt": "alpha" }, { failManifest: true });
  await expectRefusal(start(partial, 0, makePorts(restoreDesktop({}))), "checkpoint_incomplete");
  assert.equal(await runCount(), before + 2);
});

test("refusals release the lock and create no run: busy, takeover, no model, no key, no agent", { skip }, async () => {
  const runId = await makeRun();
  await capture(runId, 1, { "work/a.txt": "alpha" });
  const before = await runCount();

  const held = claimAgent(AGENT);
  const busy = makePorts(restoreDesktop({}));
  await expectRefusal(start(runId, 1, busy), "agent_busy");
  assert.equal(busy.state.prepareCalls, 0);
  held();
  assertLockFree();

  const takeover = makePorts(restoreDesktop({}));
  await expectRefusal(startBranch({ database: app, ownerId: OWNER, runId, step: 1, correction: "x", ports: takeover.ports, blobs,
    status: async () => ({ state: "running", takenOver: true }) }), "takeover_active");
  assert.equal(takeover.state.runCalls, 0);
  assertLockFree();

  for (const [reason, code] of [["no_model", "no_model"], ["no_signing_key", "no_signing_key"], ["unavailable", "agent_unavailable"]]) {
    const ports = makePorts(restoreDesktop({}), async () => ({ ok: false, reason }));
    await expectRefusal(start(runId, 1, ports), code);
    assert.equal(ports.state.runCalls, 0);
    assertLockFree();
  }
  assert.equal(await runCount(), before);
});

test("refusals before writes: blob missing, non-restorable file and too many changes", { skip }, async () => {
  const runId = await makeRun();
  await capture(runId, 1, { "inbox/r.csv": "1,2" });
  await capture(runId, 0, { "downloads/big.bin": "x".repeat(4 * 1024 * 1024 + 1) });
  await capture(runId, 2, {});
  const before = await runCount();

  const missing = makePorts(restoreDesktop({}));
  const broken = { get: async (hash) => hash === sha(Buffer.from("1,2")) ? null : blobs.get(hash), put: blobs.put, has: blobs.has };
  await expectRefusal(startBranch({ database: app, ownerId: OWNER, runId, step: 1, correction: "x", ports: missing.ports, blobs: broken,
    status: async () => ({ state: "running" }) }), "blob_missing");
  assert.equal(missing.state.runCalls, 0);
  assertLockFree();

  const oversized = makePorts(restoreDesktop({}));
  await expectRefusal(start(runId, 0, oversized), "file_not_restorable");
  assert.equal(oversized.state.runCalls, 0);

  const extra = Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`work/f${index}.txt`, `v${index}`]));
  const tooMany = makePorts(restoreDesktop(extra));
  await expectRefusal(start(runId, 2, tooMany), "too_many_changes");
  assert.equal(tooMany.state.runCalls, 0);
  assert.equal(await runCount(), before);
});

test("a mid-restore failure starts no run and the same request finishes the restore", { skip }, async () => {
  const runId = await makeRun();
  await capture(runId, 1, { "work/a.txt": "alpha", "work/b.txt": "bravo" });
  const desktop = restoreDesktop({}, { failAt: 2 });
  const ports = makePorts(desktop);
  const before = await runCount();

  await assert.rejects(start(runId, 1, ports), (error) => {
    assert.equal(error.code, "restore_failed");
    assert.deepEqual(error.restored, { put: 1, aside: 0 });
    return true;
  });
  assert.equal(ports.state.runCalls, 0, "no run starts after a restore failure");
  assert.equal(await runCount(), before);
  assertLockFree();

  desktop.options.failAt = 0;
  const result = await start(runId, 1, ports).then(async (value) => { await ports.state.done; return value; });
  assert.deepEqual(result.restored, { put: 1, aside: 0, kept: 1 });
  assert.equal(await runCount(), before + 1);
});
