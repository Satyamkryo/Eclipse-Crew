import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MAX_RESTORABLE_BYTES } from "../docker/desktop/checkpoint-tools.mjs";
import { asideFile, putFile } from "../docker/desktop/checkpoint-restore.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const BUCKET = "99999999-9999-4999-8999-999999999999";

async function withHome(run) {
  const root = await mkdtemp(path.join(tmpdir(), "eclipse-restore-"));
  const layout = { inbox: { dir: path.join(root, "inbox") }, work: { dir: path.join(root, "work") }, downloads: { dir: path.join(root, "downloads") }, outbox: { dir: path.join(root, "outbox") } };
  for (const place of Object.values(layout)) await mkdir(place.dir);
  try { await run({ root, layout }); } finally { await rm(root, { recursive: true, force: true }); }
}
const put = (layout, area, rel, content, extra = {}) =>
  putFile({ layout, area, rel, sha256: sha(content), size: content.length, read: [content], ...extra });

test("a file is written back with its directories, exact bytes and private modes", async () => {
  await withHome(async ({ layout }) => {
    const content = Buffer.from("restored invoice");
    const result = await put(layout, "work", "notes/2026/invoice.pdf", content);
    assert.deepEqual(result, { size: content.length, sha256: sha(content) });
    assert.deepEqual(await readFile(path.join(layout.work.dir, "notes", "2026", "invoice.pdf")), content);
    if (process.platform !== "win32") {
      assert.equal((await lstat(path.join(layout.work.dir, "notes"))).mode & 0o777, 0o700);
      assert.equal((await lstat(path.join(layout.work.dir, "notes", "2026", "invoice.pdf"))).mode & 0o777, 0o600);
    }
  });
});

test("an empty file is restorable", async () => {
  await withHome(async ({ layout }) => {
    await put(layout, "outbox", "empty.txt", Buffer.alloc(0));
    assert.deepEqual(await readFile(path.join(layout.outbox.dir, "empty.txt")), Buffer.alloc(0));
  });
});

test("an existing regular file is replaced with the saved bytes", async () => {
  await withHome(async ({ layout }) => {
    await writeFile(path.join(layout.inbox.dir, "report.csv"), "newer content");
    await put(layout, "inbox", "report.csv", Buffer.from("saved content"));
    assert.equal(await readFile(path.join(layout.inbox.dir, "report.csv"), "utf8"), "saved content");
  });
});

test("a wrong hash, a short body or a long body is refused, the target is untouched and no temp file remains", async () => {
  await withHome(async ({ layout }) => {
    const target = path.join(layout.work.dir, "a.txt");
    await writeFile(target, "original");
    await assert.rejects(() => putFile({ layout, area: "work", rel: "a.txt", sha256: sha("different"), size: 5, read: [Buffer.from("alpha")] }), { code: "content_changed" });
    await assert.rejects(() => putFile({ layout, area: "work", rel: "a.txt", sha256: sha("ab"), size: 1, read: [Buffer.from("ab")] }), { code: "content_changed" });
    await assert.rejects(() => putFile({ layout, area: "work", rel: "a.txt", sha256: sha("ab"), size: 2, read: [] }), { code: "content_changed" });
    assert.equal(await readFile(target, "utf8"), "original");
    assert.deepEqual((await readdir(layout.work.dir)).filter((name) => name.startsWith(".restore-")), []);
  });
});

test("path escapes, hidden names, odd names, deep paths and bad parameters are refused", async () => {
  await withHome(async ({ root, layout }) => {
    await writeFile(path.join(root, "outside.txt"), "outside");
    const bad = ["../outside.txt", "/etc/passwd", "a/../../outside.txt", "./a.txt", "a//b", "a\\b", ".hidden", "a/.x", "", "x\u0000y"];
    for (const rel of bad) await assert.rejects(() => put(layout, "work", rel, Buffer.from("x")), { code: "path_invalid" }, JSON.stringify(rel));
    await assert.rejects(() => put(layout, "work", "a/b/c/d/e/f/g.txt", Buffer.from("x")), { code: "path_invalid" }, "depth 7");
    await assert.rejects(() => put(layout, "home", "a.txt", Buffer.from("x")), { code: "path_invalid" });
    await assert.rejects(() => putFile({ layout, area: "work", rel: "a.txt", sha256: "nope", size: 1, read: [Buffer.from("x")] }), { code: "path_invalid" });
    await assert.rejects(() => putFile({ layout, area: "work", rel: "a.txt", sha256: sha("x"), size: MAX_RESTORABLE_BYTES + 1, read: [Buffer.from("x")] }), { code: "path_invalid" });
  });
});

test("symlinked targets and symlinked directories are refused", async (t) => {
  await withHome(async ({ root, layout }) => {
    await writeFile(path.join(root, "outside.txt"), "outside");
    try { await symlink(path.join(root, "outside.txt"), path.join(layout.work.dir, "leak.txt")); } catch { return t.diagnostic("symlinks are not available here"); }
    await assert.rejects(() => put(layout, "work", "leak.txt", Buffer.from("x")), { code: "target_blocked" });
    try { await symlink(root, path.join(layout.work.dir, "dir-leak")); } catch { return t.diagnostic("symlinked directories are not available here"); }
    await assert.rejects(() => put(layout, "work", "dir-leak/outside.txt", Buffer.from("x")), { code: "target_blocked" });
    assert.equal(await readFile(path.join(root, "outside.txt"), "utf8"), "outside");
  });
});

test("a hard-linked file is not replaced or moved", async (t) => {
  await withHome(async ({ layout }) => {
    const source = path.join(layout.work.dir, "a.txt");
    await writeFile(source, "alpha");
    try { await link(source, path.join(layout.work.dir, "twin.txt")); } catch { return t.diagnostic("hard links are not available here"); }
    await assert.rejects(() => put(layout, "work", "a.txt", Buffer.from("beta")), { code: "target_blocked" });
    await assert.rejects(() => asideFile({ layout, area: "work", rel: "a.txt", bucket: BUCKET }), { code: "file_not_found" });
    assert.equal(await readFile(source, "utf8"), "alpha");
  });
});

test("aside moves a later file into the hidden bucket without deleting it", async () => {
  await withHome(async ({ layout }) => {
    const file = path.join(layout.work.dir, "later", "extra.txt");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "later");
    assert.deepEqual(await asideFile({ layout, area: "work", rel: "later/extra.txt", bucket: BUCKET }), { moved: true });
    await assert.rejects(() => lstat(file));
    assert.equal(await readFile(path.join(layout.work.dir, ".rewound", BUCKET, "later", "extra.txt"), "utf8"), "later");
  });
});

test("aside never overwrites an earlier move", async () => {
  await withHome(async ({ layout }) => {
    await writeFile(path.join(layout.work.dir, "a.txt"), "one");
    await asideFile({ layout, area: "work", rel: "a.txt", bucket: BUCKET });
    await writeFile(path.join(layout.work.dir, "a.txt"), "two");
    await assert.rejects(() => asideFile({ layout, area: "work", rel: "a.txt", bucket: BUCKET }), { code: "target_blocked" });
    assert.equal(await readFile(path.join(layout.work.dir, "a.txt"), "utf8"), "two");
  });
});

test("aside refuses missing files, symlinks, path escapes and bad buckets", async (t) => {
  await withHome(async ({ root, layout }) => {
    await assert.rejects(() => asideFile({ layout, area: "work", rel: "missing.txt", bucket: BUCKET }), { code: "file_not_found" });
    await assert.rejects(() => asideFile({ layout, area: "work", rel: "a.txt", bucket: "not-a-uuid" }), { code: "path_invalid" });
    await assert.rejects(() => asideFile({ layout, area: "work", rel: "../outside.txt", bucket: BUCKET }), { code: "path_invalid" });
    await writeFile(path.join(root, "outside.txt"), "outside");
    try { await symlink(path.join(root, "outside.txt"), path.join(layout.work.dir, "leak.txt")); } catch { return t.diagnostic("symlinks are not available here"); }
    await assert.rejects(() => asideFile({ layout, area: "work", rel: "leak.txt", bucket: BUCKET }), { code: "file_not_found" });
  });
});
