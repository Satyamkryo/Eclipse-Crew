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
import { MAX_STATE_BYTES, captureState, parseState, safeIntentKey } from "../lib/checkpoints/state.ts";
import { createCheckpointRecorder, listCheckpointIndexes, loadCheckpoint } from "../lib/checkpoints/store.ts";
import { loadReceiptSigner } from "../lib/receipts/signer.ts";
import { createReceiptRecorder } from "../lib/receipts/store.ts";

const sha = (value) => createHash("sha256").update(value).digest("hex");

const snapshot = (extra = {}) => ({
  task: "Collect the monthly invoices.", turn: 2, receiptIdx: 1,
  history: [{ step: 1, action: "click", target: "Invoices", expect: "url_path: /invoices", result: "executed" }, { step: 2, action: "type", chars: 7, expect: "control_present: Search", result: "executed" }],
  documents: [{ name: "report.pdf", window: { kind: "text", offset: 100 } }, { name: "photo.png", window: { kind: "image" } }],
  delivered: ["invoice.pdf"], counters: { invalid: 0, repeats: 1, misses: 0, hardTurns: 0, hardDisabled: false },
  previous: { action: "type", text: "hunter2", expect: "control_present: Search" },
  usage: { input: 10, output: 5, cached: 0, reasoning: 0 }, ...extra,
});

// ---- state ----

test("captured state holds the task, history, document references and counters, and never typed text or contents", () => {
  const { text, state } = captureState(snapshot());
  assert.equal(state.v, 1);
  assert.deepEqual(state.documents, [{ name: "report.pdf", offset: 100 }, { name: "photo.png", offset: 0 }]);
  assert.equal(state.history[1].chars, 7);
  assert.equal(text.includes("hunter2"), false, "typed text never reaches the state");
  assert.match(state.previous, /\[7 characters\]/);
  assert.equal(text, captureState(snapshot()).text, "the same state always gives the same bytes");
  assert.deepEqual(parseState(text), state);
});

test("value names survive a checkpoint, but an extracted value never does", () => {
  const { text, state } = captureState(snapshot({ valueNames: ["headline", "price"],
    previous: { action: "extract", name: "headline", value: "TOP SECRET HEADLINE", expect: "saved" } }));
  assert.deepEqual(state.valueNames, ["headline", "price"]);
  assert.equal(text.includes("TOP SECRET HEADLINE"), false);
  assert.match(state.previous, /\[19 characters\]/);
  assert.ok(parseState(text));
  const old = { ...state }; delete old.valueNames;
  assert.ok(parseState(JSON.stringify(old)), "older checkpoints without value names still parse");
  assert.equal(parseState(JSON.stringify({ ...state, valueNames: ["UPPER", "a".repeat(33)] })), null);
});

test("a search step keeps its hit count and never its query or passages", () => {
  const { text, state } = captureState(snapshot({ history: [{ step: 1, action: "search_document", file: "report.pdf", hits: 3, result: "executed" }] }));
  assert.equal(state.history[0].hits, 3);
  assert.equal(text.includes("termination"), false);
  assert.ok(parseState(text));
});

test("a stored state is refused when it has unknown fields, wrong types or is too large", () => {
  const { text, state } = captureState(snapshot());
  for (const bad of [{ ...state, extra: 1 }, { ...state, v: 2 }, { ...state, history: [{ step: 1, action: "click", result: "weird" }] }, { ...state, counters: { ...state.counters, repeats: -1 }, }, { ...state, history: [{ step: 1, action: "click", result: "executed", secret: "x" }] }, "text", null])
    assert.equal(parseState(JSON.stringify(bad)), null, JSON.stringify(bad)?.slice(0, 60));
  assert.equal(parseState("not json"), null);
  assert.equal(parseState(" ".repeat(MAX_STATE_BYTES + 1)), null);
  assert.ok(parseState(text));
  assert.throws(() => captureState(snapshot({ task: "" })), "an empty task is not a valid state");
});

test("the previous-intent key keeps clicks and keys as they are and hides typed text", () => {
  assert.equal(safeIntentKey(null), null);
  assert.match(safeIntentKey({ action: "click", target: "Save", expect: "control_present: Done" }), /Save/);
  const typed = safeIntentKey({ action: "type", text: "p4ssw0rd!", expect: "x" });
  assert.equal(typed.includes("p4ssw0rd"), false);
  assert.equal(safeIntentKey({ action: "type", text: "ab", expect: "x" }) === safeIntentKey({ action: "type", text: "cd", expect: "x" }), true, "same length looks the same");
});

// ---- recorder against a throwaway Postgres (runs table from 0009, checkpoints from 0012) ----

const docker = (args, input) => spawnSync("docker", args, { encoding: "utf8", input, timeout: 120000 });
const dockerUp = docker(["version", "--format", "{{.Server.Version}}"]).status === 0;
const name = `eclipse-checkpoints-${randomBytes(6).toString("hex")}`;
const password = randomBytes(16).toString("hex");
const OWNER = randomUUID(); const OTHER_OWNER = randomUUID(); const AGENT = randomUUID();
const SEED = randomBytes(32).toString("hex");
let adminPool; let appPool; let app; let root; let blobs;

test.before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "eclipse-checkpoints-"));
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
  for (const file of ["0009_receipts_runs_steps.sql", "0012_quick_molten_man.sql"])
    await adminPool.query(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""));
  await adminPool.query(`ALTER TABLE runs ADD COLUMN heartbeat_at timestamptz, ADD COLUMN cancel_requested_at timestamptz;`);
  await adminPool.query(`CREATE ROLE app_role LOGIN PASSWORD '${password}'; GRANT SELECT, INSERT, UPDATE ON runs TO app_role; GRANT SELECT, INSERT ON steps TO app_role; GRANT SELECT, INSERT ON checkpoints TO app_role;`);
  appPool = new pg.Pool({ host: "127.0.0.1", port, user: "app_role", password, database: "postgres" });
  app = drizzle({ client: appPool });
});
test.after(async () => {
  await appPool?.end().catch(() => {}); await adminPool?.end().catch(() => {});
  if (dockerUp) docker(["rm", "-f", name]);
  if (root) await rm(root, { recursive: true, force: true });
});

async function newRun(owner = OWNER) {
  const recorder = createReceiptRecorder({ database: app, ownerId: owner, agentId: AGENT, agentName: "Ada", task: "t", signer: loadReceiptSigner(SEED) });
  await recorder.begin();
  return recorder.runId;
}

// A fake desktop whose "files" can change between captures. It counts how many file bodies were requested.
function fakeDesktop(initial) {
  const files = new Map(Object.entries(initial));
  const calls = { manifest: 0, blob: [] };
  const entryOf = ([key, value]) => {
    const [area, ...rest] = key.split("/");
    const bytes = Buffer.from(value);
    return bytes.length > 4 * 1024 * 1024 ? { area, path: rest.join("/"), size: bytes.length, sha256: null, restorable: false }
      : { area, path: rest.join("/"), size: bytes.length, sha256: sha(bytes), restorable: true };
  };
  return { files, calls, failures: { manifest: 0, blob: 0 }, wrongBody: false,
    async checkpointManifest() {
      calls.manifest += 1;
      if (this.failures.manifest > 0) { this.failures.manifest -= 1; throw Object.assign(new Error("scan_failed"), { code: "scan_failed" }); }
      return { entries: [...files].map(entryOf), skipped: 0 };
    },
    async checkpointBlob(file) {
      calls.blob.push(`${file.area}/${file.path}`);
      if (this.failures.blob > 0) { this.failures.blob -= 1; throw Object.assign(new Error("file_not_found"), { code: "file_not_found" }); }
      if (this.wrongBody) return Buffer.from("something else");
      return Buffer.from(files.get(`${file.area}/${file.path}`));
    } };
}

const skip = !dockerUp && "Docker is not available";

test("checkpoints store state and files by hash; an unchanged file is fetched once across the run", { skip }, async () => {
  const runId = await newRun();
  const desktop = fakeDesktop({ "work/a.txt": "alpha", "inbox/r.csv": "1,2", "downloads/big.bin": "x".repeat(4 * 1024 * 1024 + 1) });
  const recorder = createCheckpointRecorder({ database: app, ownerId: OWNER, runId, desktop, blobs });
  await recorder.capture(0, snapshot({ turn: 0, receiptIdx: 0, history: [], documents: [], delivered: [], previous: null }));
  assert.deepEqual(desktop.calls.blob.sort(), ["inbox/r.csv", "work/a.txt"], "the oversized file is never requested");
  desktop.files.set("work/b.txt", "bravo");
  await recorder.capture(1, snapshot());
  assert.deepEqual(desktop.calls.blob.sort(), ["inbox/r.csv", "work/a.txt", "work/b.txt"], "only the new file was fetched");
  desktop.files.set("work/a.txt", "alpha v2");
  await recorder.capture(2, snapshot({ receiptIdx: 2 }));
  assert.equal(desktop.calls.blob.filter((item) => item === "work/a.txt").length, 2, "a changed file is a new blob");

  const rows = (await adminPool.query("select idx, status, reason, file_count, restorable_count from checkpoints where run_id = $1 order by idx", [runId])).rows;
  assert.deepEqual(rows.map((row) => [row.idx, row.status, row.reason, row.file_count, row.restorable_count]), [[0, "complete", null, 3, 2], [1, "complete", null, 4, 3], [2, "complete", null, 4, 3]]);

  const first = await loadCheckpoint(app, OWNER, runId, 0, blobs);
  assert.equal(first.status, "complete");
  assert.deepEqual(first.entries.map((entry) => `${entry.area}/${entry.path}:${entry.restorable}`), ["downloads/big.bin:false", "inbox/r.csv:true", "work/a.txt:true"]);
  assert.deepEqual(await blobs.get(sha("alpha")), Buffer.from("alpha"), "the file content is in the store");
  assert.deepEqual(await blobs.get(sha("alpha v2")), Buffer.from("alpha v2"));
  const third = await loadCheckpoint(app, OWNER, runId, 2, blobs);
  assert.equal(third.state.receiptIdx, 2);
  assert.equal(third.state.task, "Collect the monthly invoices.");
  assert.deepEqual((await listCheckpointIndexes(app, OWNER, runId)).map((item) => item.idx), [0, 1, 2]);
});

test("a transient file problem is retried once and the checkpoint stays complete", { skip }, async () => {
  const runId = await newRun();
  const desktop = fakeDesktop({ "work/a.txt": "alpha" });
  desktop.failures.manifest = 1;
  await createCheckpointRecorder({ database: app, ownerId: OWNER, runId, desktop, blobs }).capture(0, snapshot());
  assert.equal(desktop.calls.manifest, 2);
  assert.equal((await loadCheckpoint(app, OWNER, runId, 0, blobs)).status, "complete");
});

test("a persistent problem gives a partial checkpoint with a fixed reason; the state is still saved", { skip }, async () => {
  const unreadable = fakeDesktop({ "work/z-unique-1.txt": "one" });
  unreadable.failures.blob = 5;
  const runId = await newRun();
  await createCheckpointRecorder({ database: app, ownerId: OWNER, runId, desktop: unreadable, blobs }).capture(1, snapshot());
  const partial = await loadCheckpoint(app, OWNER, runId, 1, blobs);
  assert.deepEqual([partial.status, partial.reason, partial.entries.length], ["partial", "files_unreadable", 0]);
  assert.equal(partial.state.task, "Collect the monthly invoices.", "the state is saved even when the files are not");

  const changed = fakeDesktop({ "work/z-unique-2.txt": "two" });
  changed.wrongBody = true;
  const second = await newRun();
  await createCheckpointRecorder({ database: app, ownerId: OWNER, runId: second, desktop: changed, blobs }).capture(1, snapshot());
  assert.equal((await loadCheckpoint(app, OWNER, second, 1, blobs)).reason, "content_changed", "a body that does not match its hash is never stored");
  assert.equal(await blobs.has(sha("something else")), false);

  const third = await newRun();
  await createCheckpointRecorder({ database: app, ownerId: OWNER, runId: third, desktop: { screenshot: async () => ({}) }, blobs }).capture(0, snapshot());
  assert.equal((await loadCheckpoint(app, OWNER, third, 0, blobs)).reason, "files_unsupported", "a port without file support never claims the files were saved");

  const slow = fakeDesktop({ "work/z-unique-3.txt": "three" });
  slow.checkpointManifest = () => new Promise(() => {});
  const fourth = await newRun();
  await createCheckpointRecorder({ database: app, ownerId: OWNER, runId: fourth, desktop: slow, blobs, timeoutMs: 50 }).capture(0, snapshot());
  assert.equal((await loadCheckpoint(app, OWNER, fourth, 0, blobs)).reason, "capture_timeout");
});

test("a checkpoint index cannot be written twice, and checkpoints are scoped to their owner", { skip }, async () => {
  const runId = await newRun();
  const desktop = fakeDesktop({ "work/a.txt": "alpha" });
  const recorder = createCheckpointRecorder({ database: app, ownerId: OWNER, runId, desktop, blobs });
  await recorder.capture(0, snapshot());
  await assert.rejects(() => recorder.capture(0, snapshot()), /duplicate|unique|Failed query/);
  assert.equal(await loadCheckpoint(app, OTHER_OWNER, runId, 0, blobs), null, "another owner sees nothing");
  assert.equal(await loadCheckpoint(app, OWNER, randomUUID(), 0, blobs), null);
});

test("the stored state and manifest contain no typed text, keys or file contents", { skip }, async () => {
  const runId = await newRun();
  const desktop = fakeDesktop({ "work/a.txt": "SECRET-FILE-CONTENT-123" });
  await createCheckpointRecorder({ database: app, ownerId: OWNER, runId, desktop, blobs }).capture(1, snapshot());
  const row = (await adminPool.query("select state_hash, manifest_hash from checkpoints where run_id = $1", [runId])).rows[0];
  for (const hash of [row.state_hash, row.manifest_hash]) {
    const text = (await blobs.get(hash)).toString("utf8");
    assert.equal(text.includes("hunter2"), false);
    assert.equal(text.includes("SECRET-FILE-CONTENT"), false, "contents are separate blobs, never inside state or manifest");
  }
});
