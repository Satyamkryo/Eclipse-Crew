import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";

const unwrap = (module) => module.default ?? module;
const schema = unwrap(await import("../lib/teach/schema.ts"));
const store = unwrap(await import("../lib/teach/store.ts"));
const { sha256, createBlobStore } = unwrap(await import("../lib/artifacts/blob-store.ts"));
const service = unwrap(await import("../lib/teach/service.ts"));
const { recoverNarrationClaims } = service;
const { requireNoQuery } = unwrap(await import("../lib/auth/request.ts"));
const OWNER = randomUUID(), PEER_OWNER = randomUUID(), CAPTURE = randomUUID(), PEER = randomUUID();
const LEASE = { generation: randomUUID(), connectionId: randomUUID(), leaseId: randomUUID() };
const HASH = "a".repeat(64);
const POSIX = process.platform !== "win32";
const posix = { skip: POSIX ? false : "POSIX mode-700, O_NOFOLLOW and symlink checks require the disposable Linux acceptance container" };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pSgAAAAASUVORK5CYII=", "base64");
const descriptor = (bytes = PNG, extra = {}) => ({ hash: sha256(bytes), mime: "image/png", bytes: bytes.length, kind: "before", ...extra });
const capPath = (root, owner = OWNER, capture = CAPTURE) => path.join(root, "teach", owner, capture);
const blobPath = (root, owner, capture, hash) => path.join(capPath(root, owner, capture), "blobs", hash.slice(0, 2), hash);
async function withArtifacts(run) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "eclipse-teach-test-")));
  const before = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = root;
  try { await chmod(root, 0o700); await run(root); }
  finally {
    if (before === undefined) delete process.env.ARTIFACTS_DIR; else process.env.ARTIFACTS_DIR = before;
    const parent = await realpath(tmpdir());
    assert.equal(path.dirname(root), parent, "cleanup stays inside the directly allocated temporary directory");
    assert.match(path.basename(root), /^eclipse-teach-test-/);
    await rm(root, { recursive: true, force: true });
  }
}

const routeSpecs = [
  ["../app/api/desktop/[agentId]/teach/route.ts", `/api/desktop/${OWNER}/teach`, { agentId: OWNER }, ["GET", "POST"]],
  ["../app/api/teach/[captureId]/route.ts", `/api/teach/${CAPTURE}`, { captureId: CAPTURE }, ["GET"]],
  ["../app/api/teach/[captureId]/artifact/route.ts", `/api/teach/${CAPTURE}/artifact?hash=${HASH}`, { captureId: CAPTURE }, ["GET"]],
  ["../app/api/teach/[captureId]/narration/route.ts", `/api/teach/${CAPTURE}/narration`, { captureId: CAPTURE }, ["POST"]],
];
for (const [file, url, params, methods] of routeSpecs) test(`${file}: exact method surface and anonymous owner denial before data access`, async () => {
  const route = unwrap(await import(file));
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) assert.equal(typeof route[method], methods.includes(method) ? "function" : "undefined", method);
  for (const method of methods) {
    const response = await route[method](new Request(`http://127.0.0.1:3000${url}`, { method, headers: { Origin: "http://127.0.0.1:3000", "Content-Type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify({ action: "start", privateText: "secret-sentinel" }) } : {}) }), { params: Promise.resolve(params) });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Unauthorized" });
  }
});

test("capture lookups include both owner and capture predicates; a foreign owner receives no row", async () => {
  const dialect = new PgDialect();
  let called = false;
  const database = { select: () => ({ from: () => ({ where: (predicate) => ({ limit: async (limit) => {
    called = true;
    const query = dialect.sqlToQuery(predicate);
    assert.match(query.sql, /owner_id/); assert.match(query.sql, /"id"/);
    assert.deepEqual(query.params, [PEER_OWNER, CAPTURE]); assert.equal(limit, 1);
    return [];
  } }) }) }) };
  await assert.rejects(store.ownedCapture(database, PEER_OWNER, CAPTURE), { status: 404, code: "capture_not_found" });
  assert.equal(called, true);
});

test("saved capture lists are owner+agent scoped, complete-only, newest first and capped", async () => {
  const dialect = new PgDialect();
  let query, limit;
  const database = { select: () => ({ from: () => ({ where: (predicate) => ({ orderBy: () => ({ limit: async (value) => {
    query = dialect.sqlToQuery(predicate); limit = value; return [];
  } }) }) }) }) };
  await store.listOwnedCaptures(database, OWNER, PEER);
  assert.match(query.sql, /owner_id/); assert.match(query.sql, /agent_id/); assert.match(query.sql, /state/);
  assert.deepEqual(query.params, [OWNER, PEER, "complete"]); assert.equal(limit, 20);
  const createdAt = new Date("2026-11-02T10:00:00.000Z");
  const rows = [{ id: CAPTURE, state: "complete", activeMs: 1000, eventCount: 2, narration: false, narrationStatus: "off", createdAt }];
  const fake = { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => rows }) }) }) }) };
  assert.deepEqual(await service.listCaptures(fake, OWNER, PEER),
    [{ captureId: CAPTURE, state: "complete", activeMs: 1000, eventCount: 2, narration: false, narrationStatus: "off", createdAt: createdAt.toISOString() }]);
  rows[0].state = "recording";
  await assert.rejects(service.listCaptures(fake, OWNER, PEER));
});

test("strict teach controls require a lease and capture identity and exclude raw text, credentials and unknown fields", () => {
  const start = { ...LEASE, action: "start", narration: false };
  assert.equal(schema.teachControl.safeParse(start).success, true);
  for (const mutation of [{ captureId: CAPTURE }, { generation: "../escape" }, { action: "artifact" }, { text: "secret-sentinel" }, { password: "secret-sentinel" }, { ownerId: OWNER }]) assert.equal(schema.teachControl.safeParse({ ...start, ...mutation }).success, false, JSON.stringify(mutation));
  for (const action of ["status", "pause", "resume", "stop", "discard"]) {
    assert.equal(schema.teachControl.safeParse({ ...LEASE, action, captureId: CAPTURE }).success, true);
    assert.equal(schema.teachControl.safeParse({ ...LEASE, action }).success, false);
    assert.equal(schema.teachControl.safeParse({ ...LEASE, action, captureId: CAPTURE, narration: true }).success, false);
  }
});

test("artifact hashes, upload payloads, query strings and manifest IDs fail closed", () => {
  for (const hash of ["../escape", "A".repeat(64), "a".repeat(63), HASH + "?x=secret"]) assert.equal(schema.teachHash.safeParse(hash).success, false);
  for (const captureId of ["../escape", "", HASH]) assert.equal(schema.teachControl.safeParse({ ...LEASE, action: "stop", captureId }).success, false);
  for (const query of ["?hash=a&hash=b", "?token=secret", "?captureId=../escape"]) assert.throws(() => requireNoQuery(new Request(`http://127.0.0.1:3000/api/teach/${CAPTURE}${query}`)), { code: "invalid_query" });
  const upload = { ...LEASE, sequence: 0, offsetMs: 0, mime: "audio/webm;codecs=opus", base64: "YQ==" };
  assert.equal(schema.narrationUpload.safeParse(upload).success, true);
  for (const mutation of [{ mime: "text/html" }, { sequence: -1 }, { offsetMs: 120001 }, { base64: "a?" }, { base64: "A".repeat(4 * 1024 * 1024 + 4) }, { text: "secret-sentinel" }, { url: "https://evil.invalid" }]) assert.equal(schema.narrationUpload.safeParse({ ...upload, ...mutation }).success, false);
});

const eventBase = { operation: "input.type", source_tag: "web", untrusted: true, sequence: 0, offsetMs: 0, beforeHash: HASH, afterHash: HASH, width: 1024, height: 768, target: { kind: "focused-control-redacted" } };
test("typed events are redacted placeholders and cannot contain raw text or printable key literals", () => {
  assert.equal(schema.teachEvent.safeParse({ ...eventBase, redacted: true, length: 12 }).success, true);
  for (const mutation of [{ text: "secret-sentinel", redacted: true }, { redacted: false }, {}, { target: { kind: "focused-control-redacted", value: "secret-sentinel" } }, { redacted: true, key: "a" }]) assert.equal(schema.teachEvent.safeParse({ ...eventBase, ...mutation }).success, false, JSON.stringify(mutation));
  assert.equal(schema.teachEvent.safeParse({ ...eventBase, operation: "input.key", key: "Enter" }).success, true);
  assert.equal(schema.teachEvent.safeParse({ ...eventBase, operation: "input.key", redacted: true, length: 1 }).success, true);
  for (const redacted of [undefined, true]) assert.equal(schema.teachEvent.safeParse({ ...eventBase, operation: "input.key", key: "a", ...(redacted ? { redacted } : {}) }).success, false);
});

test("orphaned narration claims expire only into uncertain and never become eligible for resend", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  const base = { hash: HASH, sequence: 0, offsetMs: 0, durationMs: 1000, source_tag: "tool", untrusted: true };
  const input = [
    { ...base, state: "in_flight", claimedAt: new Date(now - 180001).toISOString() },
    { ...base, sequence: 1, state: "in_flight" },
    { ...base, sequence: 2, state: "in_flight", claimedAt: new Date(now - 179999).toISOString() },
    { ...base, sequence: 3, state: "done" }, { ...base, sequence: 4, state: "pending" },
  ];
  const output = recoverNarrationClaims(input, now);
  assert.deepEqual(output.map((item) => item.state), ["uncertain", "uncertain", "in_flight", "done", "pending"]);
  assert.deepEqual(recoverNarrationClaims(output, now + 999999).map((item) => item.state), ["uncertain", "uncertain", "uncertain", "done", "pending"]);
  assert.equal(input[0].state, "in_flight", "claim recovery does not mutate the stored source array");
});

test("artifact validation checks hash, length, signature, dimensions and cap before touching disk", async () => {
  store.validateArtifact(PNG, descriptor());
  for (const bad of [descriptor(PNG, { hash: "f".repeat(64) }), descriptor(PNG, { bytes: PNG.length + 1 })]) assert.throws(() => store.validateArtifact(PNG, bad), /invalid_capture_hash/);
  const broken = Buffer.from(PNG); broken[0] = 0;
  assert.throws(() => store.validateArtifact(broken, descriptor(broken)), /invalid_capture_image/);
  const huge = Buffer.from(PNG); huge.writeUInt32BE(1025, 16);
  assert.throws(() => store.validateArtifact(huge, descriptor(huge)), /invalid_capture_image/);
  const falseVideo = Buffer.from("not a webm");
  assert.throws(() => store.validateArtifact(falseVideo, descriptor(falseVideo, { mime: "video/webm", kind: "video" })), /invalid_capture_video/);
  const tooLarge = Buffer.alloc(8 * 1024 * 1024 + 1);
  await assert.rejects(store.putCaptureArtifact(OWNER, CAPTURE, tooLarge, descriptor(tooLarge)));
});

test("capture blobs round-trip under their own private namespace and tampered bytes are refused", posix, async () => {
  await withArtifacts(async (root) => {
    const hash = await store.putCaptureArtifact(OWNER, CAPTURE, PNG, descriptor());
    assert.equal(hash, sha256(PNG)); assert.deepEqual(await store.getCaptureArtifact(OWNER, CAPTURE, hash), PNG);
    assert.deepEqual(await readFile(blobPath(root, OWNER, CAPTURE, hash)), PNG);
    assert.equal((await lstat(capPath(root))).mode & 0o077, 0);
    assert.equal(await store.getCaptureArtifact(PEER_OWNER, CAPTURE, hash), null);
    await writeFile(blobPath(root, OWNER, CAPTURE, hash), "tampered");
    assert.equal(await store.getCaptureArtifact(OWNER, CAPTURE, hash), null);
  });
});

test("capture, blobs and shard symlink ancestors cannot redirect either reads or writes", posix, async () => {
  for (const level of ["capture", "blobs", "shard"]) await withArtifacts(async (root) => {
    const outside = path.join(root, "outside"); await mkdir(outside, { mode: 0o700 });
    const capture = capPath(root); const hash = sha256(PNG);
    const target = level === "capture" ? capture : level === "blobs" ? path.join(capture, "blobs") : path.join(capture, "blobs", hash.slice(0, 2));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await symlink(outside, target, "dir");
    await assert.rejects(store.putCaptureArtifact(OWNER, CAPTURE, PNG, descriptor()), undefined, `${level} symlink refuses writes`);
    try { assert.equal(await store.getCaptureArtifact(OWNER, CAPTURE, hash), null); } catch (error) { assert.match(error.message, /unsafe_capture_path/); }
    assert.deepEqual(await readdir(outside), [], "no redirected blob escaped into the peer target");
  });
});

test("symlinked and hard-linked artifact files are never read as private capture bytes", posix, async () => {
  await withArtifacts(async (root) => {
    const hash = await store.putCaptureArtifact(OWNER, CAPTURE, PNG, descriptor());
    const file = blobPath(root, OWNER, CAPTURE, hash); const outside = path.join(root, "outside.png");
    await writeFile(outside, PNG); await rm(file); await symlink(outside, file);
    assert.equal(await store.getCaptureArtifact(OWNER, CAPTURE, hash), null);
    await rm(file); await link(outside, file);
    assert.equal(await store.getCaptureArtifact(OWNER, CAPTURE, hash), null);
    assert.deepEqual(await readFile(outside), PNG);
  });
});

test("discard removes only the requested capture and preserves peer-owner, peer-capture and shared receipt blobs", posix, async () => {
  await withArtifacts(async (root) => {
    const hash = await store.putCaptureArtifact(OWNER, CAPTURE, PNG, descriptor());
    await store.putCaptureArtifact(OWNER, PEER, PNG, descriptor());
    await store.putCaptureArtifact(PEER_OWNER, CAPTURE, PNG, descriptor());
    const shared = createBlobStore(root); await shared.put(PNG);
    await store.discardCaptureArtifacts(OWNER, CAPTURE);
    assert.equal(await store.getCaptureArtifact(OWNER, CAPTURE, hash), null);
    assert.deepEqual(await store.getCaptureArtifact(OWNER, PEER, hash), PNG);
    assert.deepEqual(await store.getCaptureArtifact(PEER_OWNER, CAPTURE, hash), PNG);
    assert.deepEqual(await shared.get(hash), PNG);
    for (const invalid of ["../escape", "", "a/b"]) await assert.rejects(store.discardCaptureArtifacts(OWNER, invalid));
  });
});
