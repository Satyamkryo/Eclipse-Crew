import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MAX_BLOB_BYTES, createBlobStore, sha256 } from "../lib/artifacts/blob-store.ts";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function withStore(run) {
  const root = await mkdtemp(path.join(tmpdir(), "eclipse-blobs-"));
  try { await run(createBlobStore(root), root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("a blob is stored under its own SHA-256 and read back identically", async () => {
  await withStore(async (store, root) => {
    const bytes = Buffer.from("hello checkpoint");
    const hash = await store.put(bytes);
    assert.equal(hash, sha(bytes));
    assert.equal(sha256(bytes), hash);
    assert.equal(await store.has(hash), true);
    assert.deepEqual(await store.get(hash), bytes);
    assert.ok((await stat(path.join(root, "blobs", hash.slice(0, 2), hash))).isFile());
  });
});

test("putting the same bytes twice stores one file and leaves no temp files", async () => {
  await withStore(async (store, root) => {
    const bytes = Buffer.from("same");
    const first = await store.put(bytes);
    const second = await store.put(Buffer.from("same"));
    assert.equal(first, second);
    assert.deepEqual(await readdir(path.join(root, "blobs", first.slice(0, 2))), [first]);
  });
});

test("only 64-character lowercase hex names reach the filesystem", async () => {
  await withStore(async (store) => {
    for (const bad of ["", "../etc/passwd", "a".repeat(63), "A".repeat(64), `${"a".repeat(63)}/`, "..".repeat(32)]) {
      assert.equal(await store.get(bad), null, bad);
      await assert.rejects(() => store.has(bad), /invalid_hash/);
    }
  });
});

test("a missing, tampered, symlinked or oversized blob reads as null", async () => {
  await withStore(async (store, root) => {
    assert.equal(await store.get("0".repeat(64)), null);
    const hash = await store.put(Buffer.from("original"));
    await writeFile(path.join(root, "blobs", hash.slice(0, 2), hash), "changed");
    assert.equal(await store.get(hash), null, "bytes no longer match the name");

    const target = path.join(root, "outside.txt");
    await writeFile(target, "secret");
    const linkHash = sha("secret");
    const dir = path.join(root, "blobs", linkHash.slice(0, 2));
    await mkdir(dir, { recursive: true });
    await symlink(target, path.join(dir, linkHash)).catch(() => undefined);
    assert.equal(await store.get(linkHash), null, "a symlink is never followed");

    await assert.rejects(() => store.put(Buffer.alloc(MAX_BLOB_BYTES + 1)), /blob_too_large/);
  });
});
