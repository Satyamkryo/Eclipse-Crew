import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MAX_FILES, MAX_RESTORABLE_BYTES, readBlob, scanManifest } from "../docker/desktop/checkpoint-tools.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function withHome(run) {
  const root = await mkdtemp(path.join(tmpdir(), "eclipse-checkpoint-"));
  const layout = { inbox: { dir: path.join(root, "inbox") }, work: { dir: path.join(root, "work") }, downloads: { dir: path.join(root, "downloads") }, outbox: { dir: path.join(root, "outbox") } };
  try { await run({ root, layout }); } finally { await rm(root, { recursive: true, force: true }); }
}
const put = async (file, content) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content); };

test("the manifest lists regular files in all four areas with their SHA-256, sorted, nested paths included", async () => {
  await withHome(async ({ layout }) => {
    await put(path.join(layout.work.dir, "notes", "b.txt"), "bravo");
    await put(path.join(layout.work.dir, "a.txt"), "alpha");
    await put(path.join(layout.inbox.dir, "report.csv"), "x,y\n1,2\n");
    await put(path.join(layout.downloads.dir, "invoice.pdf"), "%PDF-1.4");
    await put(path.join(layout.outbox.dir, "result.txt"), "done");
    const { entries, skipped } = await scanManifest({ layout });
    assert.equal(skipped, 0);
    assert.deepEqual(entries.map((entry) => `${entry.area}/${entry.path}`), ["inbox/report.csv", "work/a.txt", "work/notes/b.txt", "downloads/invoice.pdf", "outbox/result.txt"]);
    assert.equal(entries.find((entry) => entry.path === "a.txt").sha256, sha("alpha"));
    assert.ok(entries.every((entry) => entry.restorable && entry.sha256 && !entry.path.includes(layout.work.dir)), "no absolute paths in output");
  });
});

test("an area that does not exist yet is skipped, not an error", async () => {
  await withHome(async ({ layout }) => {
    await put(path.join(layout.work.dir, "a.txt"), "alpha");
    const { entries } = await scanManifest({ layout });
    assert.deepEqual(entries.map((entry) => entry.path), ["a.txt"]);
  });
});

test("files over 4 MiB are listed by name and size only, with no hash and not restorable", async () => {
  await withHome(async ({ layout }) => {
    await put(path.join(layout.work.dir, "big.bin"), Buffer.alloc(MAX_RESTORABLE_BYTES + 1, 7));
    await put(path.join(layout.work.dir, "edge.bin"), Buffer.alloc(MAX_RESTORABLE_BYTES, 7));
    const { entries } = await scanManifest({ layout });
    assert.deepEqual(entries.map((entry) => [entry.path, entry.size, entry.sha256 === null, entry.restorable]),
      [["big.bin", MAX_RESTORABLE_BYTES + 1, true, false], ["edge.bin", MAX_RESTORABLE_BYTES, false, true]]);
  });
});

test("hidden files, odd names, hard links and symlinks are skipped and counted, never followed", async (t) => {
  await withHome(async ({ root, layout }) => {
    await put(path.join(layout.work.dir, "ok.txt"), "ok");
    await put(path.join(layout.work.dir, ".hidden"), "h");
    await put(path.join(layout.work.dir, ".x.part"), "p");
    await put(path.join(root, "outside.txt"), "secret outside");
    let linked = true;
    try { await symlink(path.join(root, "outside.txt"), path.join(layout.work.dir, "leak.txt")); await symlink(root, path.join(layout.work.dir, "dir-leak")); } catch { linked = false; }
    let hard = true;
    try { await link(path.join(layout.work.dir, "ok.txt"), path.join(layout.work.dir, "twin.txt")); } catch { hard = false; }
    const { entries, skipped } = await scanManifest({ layout });
    const names = entries.map((entry) => entry.path);
    assert.ok(!names.includes(".hidden") && !names.includes(".x.part"));
    if (linked) assert.ok(!names.includes("leak.txt") && !names.some((name) => name.startsWith("dir-leak")), "symlinks are not followed");
    if (hard) assert.ok(!names.includes("ok.txt") && !names.includes("twin.txt"), "hard-linked files are skipped");
    else assert.deepEqual(names, ["ok.txt"]);
    assert.ok(skipped >= 2);
    if (!linked) t.diagnostic("symlinks are not available here; link checks skipped");
  });
});

test("depth, file-count and time limits fail with fixed codes", async () => {
  await withHome(async ({ layout }) => {
    await put(path.join(layout.work.dir, "a", "b", "c", "d", "e", "f", "g", "too-deep.txt"), "deep");
    await put(path.join(layout.work.dir, "a", "b", "c", "d", "e", "f", "ok.txt"), "ok");
    const { entries, skipped } = await scanManifest({ layout });
    assert.deepEqual(entries.map((entry) => entry.path), ["a/b/c/d/e/f/ok.txt"]);
    assert.equal(skipped, 1, "the directory below the depth limit is skipped");

    await put(path.join(layout.work.dir, "second.txt"), "two");
    await assert.rejects(() => scanManifest({ layout, maxFiles: 1 }), { code: "too_many_files" });
    let tick = 0;
    await assert.rejects(() => scanManifest({ layout, now: () => (tick += 10_000), limitMs: 5000 }), { code: "scan_limit" });
    assert.equal(MAX_FILES, 2000);
  });
});

test("a blob is returned only while it still hashes to the manifest value", async () => {
  await withHome(async ({ layout }) => {
    const file = path.join(layout.work.dir, "notes", "a.txt");
    await put(file, "alpha");
    const ok = await readBlob({ layout, area: "work", rel: "notes/a.txt", sha256: sha("alpha") });
    assert.deepEqual([ok.size, Buffer.from(ok.base64, "base64").toString()], [5, "alpha"]);
    await writeFile(file, "ALPHA");
    await utimes(file, new Date(), new Date());
    await assert.rejects(() => readBlob({ layout, area: "work", rel: "notes/a.txt", sha256: sha("alpha") }), { code: "content_changed" });
  });
});

test("blob requests cannot leave the agent's areas", async (t) => {
  await withHome(async ({ root, layout }) => {
    await put(path.join(root, "outside.txt"), "secret outside");
    await put(path.join(layout.work.dir, "a.txt"), "alpha");
    const request = (area, rel, content = "secret outside") => readBlob({ layout, area, rel, sha256: sha(content) });
    for (const rel of ["../outside.txt", "/etc/passwd", "a/../../outside.txt", "./a.txt", "a//b", "a\\b", "", ".hidden", "x\u0000y"])
      await assert.rejects(() => request("work", rel), { code: "file_not_found" }, `rel ${JSON.stringify(rel)}`);
    await assert.rejects(() => request("home", "a.txt"), { code: "file_not_found" });
    await assert.rejects(() => request("work", "a.txt", "different content"), { code: "content_changed" });
    await assert.rejects(() => readBlob({ layout, area: "work", rel: "a.txt", sha256: "not-a-hash" }), { code: "file_not_found" });
    try {
      await symlink(path.join(root, "outside.txt"), path.join(layout.work.dir, "leak.txt"));
      await assert.rejects(() => request("work", "leak.txt"), { code: "file_not_found" }, "a symlink is never read");
      await symlink(root, path.join(layout.work.dir, "dir-leak"));
      await assert.rejects(() => request("work", "dir-leak/outside.txt"), { code: "file_not_found" }, "a symlinked directory is never entered");
    } catch (error) { if (error?.code === "ERR_ASSERTION") throw error; t.diagnostic("symlinks are not available here; link checks skipped"); }
    await put(path.join(layout.work.dir, "big.bin"), Buffer.alloc(MAX_RESTORABLE_BYTES + 1, 1));
    await assert.rejects(() => readBlob({ layout, area: "work", rel: "big.bin", sha256: sha("x") }), { code: "file_too_large" });
  });
});
