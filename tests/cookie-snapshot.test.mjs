import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_AGE_MS, MAX_COOKIES, MAX_SNAPSHOT_BYTES, SNAPSHOT_NAME, fingerprint, readSnapshot, serialize,
  sessionCookies, validateSnapshot, writeSnapshot,
} from "../docker/desktop/cookie-snapshot.mjs";

const uid = process.getuid?.() ?? 0;
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const cookie = (overrides = {}) => ({
  name: "sess", value: "synthetic-value", domain: "127.0.0.1", path: "/", expires: -1,
  httpOnly: false, secure: false, sameSite: "Lax", ...overrides,
});

async function withDirectory(operation) {
  const root = realpathSync(tmpdir());
  const directory = mkdtempSync(path.join(root, "eclipse-cookie-test-"));
  try { return await operation(directory); } finally {
    assert.equal(path.dirname(realpathSync(directory)), root);
    rmSync(directory, { recursive: true, force: true });
  }
}
const leftovers = (directory) => readdirSync(directory).filter((name) => name !== SNAPSHOT_NAME);

test("only cookies without an expiry are kept, reduced to the saved fields and sorted", () => {
  const result = sessionCookies([
    cookie({ name: "b", extra: "dropped" }),
    cookie({ name: "persistent", expires: 1893456000 }),
    cookie({ name: "a", domain: ".example.com", sameSite: "None", secure: true, httpOnly: true, partitionKey: "https://top.example" }),
  ]);
  assert.deepEqual(result.map((item) => item.name).sort(), ["a", "b"]);
  assert.deepEqual(
    sessionCookies([cookie({ name: "z" }), cookie({ name: "a" })]).map((item) => item.name),
    sessionCookies([cookie({ name: "a" }), cookie({ name: "z" })]).map((item) => item.name),
    "output order does not depend on input order",
  );
  assert.ok(result.every((item) => !("extra" in item) && !("expires" in item)));
  assert.equal(result.find((item) => item.name === "a").partitionKey, "https://top.example");
  assert.deepEqual(sessionCookies(null), []);
  assert.deepEqual(sessionCookies("nope"), []);
});

test("malformed cookies are dropped one by one without failing the rest", () => {
  const bad = [
    cookie({ name: "" }), cookie({ name: "x\u0000y" }), cookie({ value: "a\nb" }), cookie({ value: "v".repeat(4097) }),
    cookie({ domain: "" }), cookie({ domain: "ex ample.com" }), cookie({ path: "relative" }), cookie({ path: "/a\u0001" }),
    cookie({ httpOnly: "yes" }), cookie({ secure: 1 }), cookie({ sameSite: "Bogus" }), cookie({ partitionKey: "" }), null, 7,
  ];
  assert.deepEqual(sessionCookies([...bad, cookie({ name: "good" })]).map((item) => item.name), ["good"]);
});

test("the cookie count is bounded", () => {
  const many = Array.from({ length: MAX_COOKIES + 50 }, (_, index) => cookie({ name: `c${index}` }));
  assert.equal(sessionCookies(many).length, MAX_COOKIES);
});

test("snapshot validation accepts only the exact shape and a fresh timestamp", () => {
  const good = JSON.parse(serialize(sessionCookies([cookie()]), NOW));
  assert.equal(validateSnapshot(good, NOW).length, 1);
  assert.equal(validateSnapshot(good, NOW + MAX_AGE_MS - 1000).length, 1);
  for (const broken of [
    null, [], "x", { ...good, version: 2 }, { ...good, extra: true }, { ...good, savedAt: "not a date" },
    { ...good, savedAt: new Date(NOW + 2 * 86400000).toISOString() }, { ...good, cookies: "nope" },
    { ...good, cookies: Array.from({ length: MAX_COOKIES + 1 }, () => cookie()) },
  ]) assert.equal(validateSnapshot(broken, NOW), null);
  assert.equal(validateSnapshot(good, NOW + MAX_AGE_MS + 1000), null, "snapshots older than 30 days are rejected");
  const mixed = { ...good, cookies: [cookie(), { name: "" }] };
  assert.equal(validateSnapshot(mixed, NOW).length, 1, "bad entries are skipped, good ones kept");
});

test("a saved snapshot round-trips, is private, atomic and leaves no temp file", () => withDirectory(async (directory) => {
  const cookies = sessionCookies([cookie({ name: "login", value: "synthetic-login-value" }), cookie({ name: "other", path: "/app" })]);
  await writeSnapshot(directory, cookies, NOW);
  assert.deepEqual(leftovers(directory), []);
  if (process.platform !== "win32") assert.equal(lstatSync(path.join(directory, SNAPSHOT_NAME)).mode & 0o777, 0o600);
  assert.deepEqual(await readSnapshot(directory, uid, NOW), cookies);
  assert.equal(fingerprint(cookies), fingerprint(sessionCookies([cookie({ name: "other", path: "/app" }), cookie({ name: "login", value: "synthetic-login-value" })])), "order does not change the fingerprint");
}));

test("saving zero cookies removes the file so a logout is not undone", () => withDirectory(async (directory) => {
  await writeSnapshot(directory, sessionCookies([cookie()]), NOW);
  assert.equal(readdirSync(directory).includes(SNAPSHOT_NAME), true);
  await writeSnapshot(directory, [], NOW);
  assert.deepEqual(readdirSync(directory), []);
  await writeSnapshot(directory, [], NOW);
  assert.deepEqual(await readSnapshot(directory, uid, NOW), []);
}));

test("an oversized snapshot is refused on write and leaves nothing behind", () => withDirectory(async (directory) => {
  const huge = Array.from({ length: 400 }, (_, index) => cookie({ name: `c${index}`, value: "v".repeat(4000) }));
  await assert.rejects(writeSnapshot(directory, huge, NOW), /snapshot_too_large/);
  assert.deepEqual(readdirSync(directory), []);
}));

test("untrusted snapshot files are ignored and never throw", () => withDirectory(async (directory) => {
  const target = path.join(directory, SNAPSHOT_NAME);
  const valid = serialize(sessionCookies([cookie()]), NOW);

  assert.deepEqual(await readSnapshot(directory, uid, NOW), [], "missing file");
  writeFileSync(target, "{not json", { mode: 0o600 });
  assert.deepEqual(await readSnapshot(directory, uid, NOW), [], "corrupt file");
  writeFileSync(target, JSON.stringify({ version: 1, savedAt: new Date(NOW).toISOString(), cookies: "x" }), { mode: 0o600 });
  assert.deepEqual(await readSnapshot(directory, uid, NOW), [], "wrong shape");
  assert.deepEqual(readdirSync(directory), [], "an unusable snapshot is deleted");

  writeFileSync(target, "x".repeat(MAX_SNAPSHOT_BYTES + 1), { mode: 0o600 });
  assert.deepEqual(await readSnapshot(directory, uid, NOW), [], "oversized file");
  rmSync(target);

  writeFileSync(target, valid, { mode: 0o600 });
  assert.equal((await readSnapshot(directory, uid + 1, NOW)).length, 0, "wrong owner");
  assert.equal((await readSnapshot(directory, uid, NOW + MAX_AGE_MS + 5000)).length, 0, "expired snapshot");
  rmSync(target, { force: true });

  if (process.platform !== "win32") {
    writeFileSync(target, valid, { mode: 0o600 });
    chmodSync(target, 0o644);
    assert.deepEqual(await readSnapshot(directory, uid, NOW), [], "group/other readable file");
  }
}));

test("a symlinked snapshot is never followed, and a write replaces the link itself", (t) => withDirectory(async (directory) => {
  const secret = path.join(directory, "elsewhere.json");
  const target = path.join(directory, SNAPSHOT_NAME);
  writeFileSync(secret, serialize(sessionCookies([cookie({ name: "planted" })]), NOW), { mode: 0o600 });
  try { symlinkSync(secret, target, "file"); } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.skip(`symlinks unavailable: ${error.code}`); return; }
    throw error;
  }
  assert.deepEqual(await readSnapshot(directory, uid, NOW), [], "read through a symlink is refused");
  const before = readFileSync(secret, "utf8");
  await writeSnapshot(directory, sessionCookies([cookie({ name: "real" })]), NOW);
  assert.equal(readFileSync(secret, "utf8"), before, "the link target is not written through");
  assert.equal(lstatSync(target).isSymbolicLink(), false, "the link is replaced by a regular file");
  assert.equal((await readSnapshot(directory, uid, NOW))[0].name, "real");
}));
