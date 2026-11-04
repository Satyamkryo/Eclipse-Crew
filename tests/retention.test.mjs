import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EVIDENCE_RETENTION_DAYS, sweepOldEvidence } from "../lib/retention/sweep.ts";
import { createBlobStore } from "../lib/artifacts/blob-store.ts";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const DAY_MS = 24 * 60 * 60 * 1000;

// NOTE: the stub dispatches on selected columns, not table identity: tests
// import schema as "../db/schema.ts" while lib uses "../../db/schema", and tsx
// loads those as two module instances, so `===` on tables never matches.
function stubDatabase(rows) {
  return {
    select: (cols) => {
      const names = Object.keys(cols || {});
      const list = names.includes("beforeHash") ? rows.evidence
        : names.includes("stateHash") ? rows.points
        : names.includes("state") ? (rows.captureState || [])
        : (rows.teach || []);
      const arr = [...list];
      // `limit` is honored so a capped keep-set query would show up as lost protection.
      return { from: () => ({ where: () => Object.assign(arr, { limit: (n) => list.slice(0, n) }) }) };
    },
  };
}

async function blobFile(root, bytes, ageDays) {
  const hash = sha(bytes);
  const file = path.join(root, "blobs", hash.slice(0, 2), hash);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  const past = new Date(Date.now() - ageDays * DAY_MS);
  await utimes(file, past, past);
  return { hash, file };
}

test("sweep deletes old unreferenced blobs and keeps recent or referenced ones", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  process.env.ARTIFACTS_DIR = root;
  const oldFree = await blobFile(root, randomBytes(64), 40);
  const oldKept = await blobFile(root, randomBytes(64), 40);
  const fresh = await blobFile(root, randomBytes(64), 1);
  const { existsSync } = await import("node:fs");
  const database = stubDatabase({
    evidence: [{ beforeHash: oldKept.hash, afterHash: null }],
    points: [],
    teach: [],
  });
  const result = await sweepOldEvidence(database, new Date(), EVIDENCE_RETENTION_DAYS);
  assert.equal(result.blobsDeleted, 1);
  assert.equal(existsSync(oldFree.file), false);
  assert.equal(existsSync(oldKept.file), true);
  assert.equal(existsSync(fresh.file), true);
});

test("sweep honors a shorter keep window and skips active teach captures", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  process.env.ARTIFACTS_DIR = root;
  const mid = await blobFile(root, randomBytes(64), 10);
  const { existsSync } = await import("node:fs");
  const captureId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  const ownerId = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
  const captureDir = path.join(root, "teach", ownerId, captureId);
  await mkdir(captureDir, { recursive: true });
  const past = new Date(Date.now() - 40 * DAY_MS);
  await utimes(captureDir, past, past);
  const database = stubDatabase({ evidence: [], points: [], teach: [] });
  const kept = await sweepOldEvidence(database, new Date(), 32);
  assert.equal(kept.blobsDeleted, 0);
  assert.equal(existsSync(mid.file), true);
  assert.equal(kept.teachDeleted, 1);
  assert.equal(existsSync(captureDir), false);
  const purged = await sweepOldEvidence(database, new Date(), 7);
  assert.equal(purged.blobsDeleted, 1);
  assert.equal(existsSync(mid.file), false);
});

test("reusing a stored blob (put or touch) refreshes its age so the sweep keeps it", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  process.env.ARTIFACTS_DIR = root;
  const { existsSync } = await import("node:fs");
  const bytesA = randomBytes(64);
  const reusedByPut = await blobFile(root, bytesA, 40);
  const reusedByTouch = await blobFile(root, randomBytes(64), 40);
  const untouched = await blobFile(root, randomBytes(64), 40);
  const store = createBlobStore(root);
  assert.equal(await store.put(bytesA), reusedByPut.hash, "dedupe returns the same hash");
  assert.equal(await store.touch(reusedByTouch.hash), true);
  assert.equal(await store.touch("0".repeat(64)), false, "touch on a missing blob reports false");
  const database = stubDatabase({ evidence: [], points: [], teach: [] });
  const result = await sweepOldEvidence(database, new Date(), EVIDENCE_RETENTION_DAYS);
  assert.equal(result.blobsDeleted, 1);
  assert.equal(existsSync(reusedByPut.file), true, "put on an existing blob marks it used");
  assert.equal(existsSync(reusedByTouch.file), true, "touch marks an unchanged checkpoint file used");
  assert.equal(existsSync(untouched.file), false);
});

test("every recent checkpoint protects its manifest files, beyond the old 5000-row cap", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  process.env.ARTIFACTS_DIR = root;
  const { existsSync } = await import("node:fs");
  const oldFile = await blobFile(root, randomBytes(64), 40);
  const manifest = await blobFile(root, Buffer.from(JSON.stringify({ v: 1, entries: [{ sha256: oldFile.hash }] })), 40);
  const filler = await blobFile(root, randomBytes(64), 1);
  const points = Array.from({ length: 6000 }, () => ({ stateHash: filler.hash, manifestHash: null }));
  points.push({ stateHash: filler.hash, manifestHash: manifest.hash });
  const result = await sweepOldEvidence(stubDatabase({ evidence: [], points, teach: [] }), new Date(), EVIDENCE_RETENTION_DAYS);
  assert.equal(result.blobsDeleted, 0);
  assert.equal(existsSync(manifest.file), true, "the 6001st checkpoint's manifest is kept");
  assert.equal(existsSync(oldFile.file), true, "and the unchanged file it lists is kept");
});

test("a non-owner folder under teach/ is skipped without aborting the teach pass", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  process.env.ARTIFACTS_DIR = root;
  const { existsSync } = await import("node:fs");
  const past = new Date(Date.now() - 40 * DAY_MS);
  const stray = path.join(root, "teach", "lost+found", "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa");
  const owned = path.join(root, "teach", "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", "cccccccc-3333-4333-8333-cccccccccccc");
  for (const directory of [stray, owned]) {
    await mkdir(directory, { recursive: true });
    await utimes(directory, past, past);
  }
  const queried = [];
  const database = stubDatabase({ evidence: [], points: [], teach: [] });
  const select = database.select;
  database.select = (cols) => { if (cols && "state" in cols) queried.push(cols); return select(cols); };
  const result = await sweepOldEvidence(database, new Date(), EVIDENCE_RETENTION_DAYS);
  assert.equal(result.teachDeleted, 1);
  assert.equal(existsSync(stray), true, "a folder that is not an owner id is never deleted");
  assert.equal(existsSync(owned), false);
  assert.equal(queried.length, 1, "no database lookup is made for the stray folder");
});

test("the storage meter route requires the owner session and never caches an error", async () => {
  const route = await import("../app/api/storage/route.ts");
  const { GET } = route.default ?? route;
  const response = await GET(new Request("http://127.0.0.1:3000/api/storage?x=1"));
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const source = (await import("node:fs")).readFileSync("app/api/storage/route.ts", "utf8");
  assert.match(source, /requireOwnerRequest\(request\);\s*requireNoQuery\(request\);/, "query strings are refused after auth");
});
