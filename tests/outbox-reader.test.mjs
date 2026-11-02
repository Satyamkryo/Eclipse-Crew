import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { link, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canOpen, checkOpenable, isPlainName, listOutbox, readOutbox } from "../docker/desktop/outbox-reader.mjs";

const POSIX = process.platform !== "win32";
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
const png = (size = 3000) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(size - 8)]);
const OLD = Date.now() - 60_000;
async function outbox(t) {
  const root = await mkdtemp(path.join(tmpdir(), "outbox-"));
  const directory = path.join(root, "outbox");
  await mkdir(directory, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name, content, age = OLD) => { await writeFile(path.join(directory, name), content); const when = new Date(age); await utimes(path.join(directory, name), when, when); };
  return { directory, put, root };
}
const code = async (promise) => { try { await promise; } catch (error) { return error.code; } return "no error"; };
async function read(directory, name, body) {
  const chunks = [];
  await readOutbox({ outbox: directory, name, sha256: sha(body), size: body.length, write: async (value) => { chunks.push(Buffer.from(value)); } });
  const all = Buffer.concat(chunks); const end = all.indexOf(10);
  return { header: JSON.parse(all.subarray(0, end).toString()), body: all.subarray(end + 1) };
}

test("plain names exclude separators, controls, hidden files and non-NFC text", () => {
  for (const good of ["report.pdf", "my file (1).png", "é.txt", "a.b.c"]) assert.equal(isPlainName(good), true, good);
  for (const bad of ["", ".hidden", "a/b", "a\\b", "x\u0000y", " lead", "trail ", "e\u0301.txt", "\ud800", "x".repeat(256), 5, null]) assert.equal(isPlainName(bad), false, String(bad));
});

test("only new, settled, regular, single-link files are listed, with kind, size and SHA-256", async (t) => {
  const { directory, put } = await outbox(t); const picture = png(); const notes = Buffer.from("plain notes\n");
  await put("chart.png", picture); await put("notes.txt", notes); await put(".secret", "x"); await put("empty.txt", ""); await put("tool.exe", Buffer.from("MZ plain text")); await put("cleanup.bat", "del /q *"); await put("run.SH", "echo hi");
  await put("bin.dat", Buffer.from([1, 2, 3, 0, 4, 5])); await put("fresh.txt", "still being written", Date.now());
  await mkdir(path.join(directory, "folder"));
  const { files, pending } = await listOutbox({ outbox: directory });
  const byName = Object.fromEntries(files.map((file) => [file.name, file]));
  assert.deepEqual(Object.keys(byName).sort(), ["chart.png", "notes.txt"], "unknown binary, scripts by name, hidden, empty, directory and fresh files are left out");
  assert.deepEqual(byName["chart.png"], { name: "chart.png", size: picture.length, kind: "image", sha256: sha(picture) });
  assert.equal(byName["notes.txt"].kind, "text");
  assert.equal(pending, 1, "the file still being written is retried on a later scan");
  assert.equal(Object.keys(files[0]).sort().join(), "kind,name,sha256,size");
});

test("files that already have a card are skipped without being hashed, a changed size is new", async (t) => {
  const { directory, put } = await outbox(t);
  await put("a.txt", "first version"); await put("b.txt", "second");
  const first = await listOutbox({ outbox: directory });
  assert.equal(first.files.length, 2);
  const known = first.files.map((file) => [file.name, file.size]);
  assert.deepEqual((await listOutbox({ outbox: directory, known })).files, []);
  await put("a.txt", "a longer second version");
  const again = await listOutbox({ outbox: directory, known });
  assert.deepEqual(again.files.map((file) => file.name), ["a.txt"]);
});

test("at most five new files are hashed per scan, oldest first, and the rest wait", async (t) => {
  const { directory, put } = await outbox(t);
  for (let n = 0; n < 8; n++) await put(`f${n}.txt`, `file ${n}`, OLD - (8 - n) * 1000);
  const first = await listOutbox({ outbox: directory });
  assert.deepEqual(first.files.map((file) => file.name), ["f0.txt", "f1.txt", "f2.txt", "f3.txt", "f4.txt"]);
  assert.equal(first.pending, 3);
  const second = await listOutbox({ outbox: directory, known: first.files.map((file) => [file.name, file.size]) });
  assert.deepEqual(second.files.map((file) => file.name), ["f5.txt", "f6.txt", "f7.txt"]);
  assert.equal(second.pending, 0);
});

test("a symlink, a hard link and a symlinked outbox are never listed or read", { skip: !POSIX }, async (t) => {
  const { directory, put, root } = await outbox(t);
  await writeFile(path.join(root, "outside.txt"), "private data");
  await symlink(path.join(root, "outside.txt"), path.join(directory, "alias.txt"));
  await put("real.txt", "shared content"); await link(path.join(directory, "real.txt"), path.join(directory, "twin.txt"));
  await put("fine.txt", "fine");
  const { files } = await listOutbox({ outbox: directory });
  assert.deepEqual(files.map((file) => file.name), ["fine.txt"]);
  assert.equal(await code(read(directory, "alias.txt", Buffer.from("private data"))), "file_not_found");
  assert.equal(await code(read(directory, "twin.txt", Buffer.from("shared content"))), "file_not_found");
  await symlink(directory, path.join(root, "link"));
  assert.equal(await code(listOutbox({ outbox: path.join(root, "link") })), "scan_failed");
});

test("a download is byte-identical and only starts if the file still matches its card", async (t) => {
  const { directory, put } = await outbox(t); const body = Buffer.concat([png(), randomBytes(3 * 1024 * 1024)]);
  await put("big.png", body);
  const result = await read(directory, "big.png", body);
  assert.deepEqual(result.header, { size: body.length }); assert.equal(sha(result.body), sha(body));
  const sent = [];
  await put("big.png", Buffer.concat([body.subarray(0, body.length - 1), Buffer.from([9])]));
  assert.equal(await code(readOutbox({ outbox: directory, name: "big.png", sha256: sha(body), size: body.length, write: async (value) => { sent.push(value); } })), "file_changed");
  await put("big.png", body.subarray(0, 100));
  assert.equal(await code(readOutbox({ outbox: directory, name: "big.png", sha256: sha(body), size: body.length, write: async (value) => { sent.push(value); } })), "file_changed");
  assert.deepEqual(sent, [], "nothing was sent for a changed file");
  await put("cleanup.bat", body); assert.equal(await code(read(directory, "cleanup.bat", body)), "file_not_found", "a script name is never served");
  assert.equal(await code(read(directory, "gone.png", body)), "file_not_found");
  assert.equal(await code(read(directory, "../etc/passwd", body)), "file_not_found");
  assert.equal(await code(read(directory, "sub/file", body)), "file_not_found");
});

test("only safe kinds with a matching safe extension can be opened on the desktop", async (t) => {
  const { directory, put } = await outbox(t);
  await put("photo.png", png()); await put("doc.pdf", Buffer.from("%PDF-1.7\nbody")); await put("notes.md", "# title\n"); await put("page.html", "<script>alert(1)</script>");
  await put("sneaky.html", png()); await put("data.bin", Buffer.from("plain text under an unknown name")); await put("pack.zip", Buffer.from("PK\x03\x04junk"));
  for (const name of ["photo.png", "doc.pdf", "notes.md"]) assert.equal((await checkOpenable(directory, name)).name, name);
  for (const name of ["page.html", "sneaky.html", "data.bin", "pack.zip"]) assert.equal(await code(checkOpenable(directory, name)), "type_blocked", name);
  assert.equal(await code(checkOpenable(directory, "missing.png")), "file_not_found");
  assert.equal(await code(checkOpenable(directory, "../photo.png")), "file_not_found");
  assert.equal(canOpen("a.bmp", "image"), true); assert.equal(canOpen("a.avif", "image"), true); for (const name of ["a.tiff", "a.ico", "a.heic", "a.wmv", "a.flv", "a.mpg"]) assert.equal(canOpen(name, name.endsWith("g") || name === "a.flv" || name === "a.wmv" ? "video" : "image"), false, name);
  // H.264 video is download-only: the agent's Chromium cannot decode it and shows a blank player.
  for (const name of ["a.mp4", "a.mov", "a.mkv"]) assert.equal(canOpen(name, "video"), false, name);
  for (const name of ["a.webm", "a.ogv"]) assert.equal(canOpen(name, "video"), true, name);
  await put("clip.mp4", Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypmp42"), Buffer.alloc(64)]));
  assert.equal(await code(checkOpenable(directory, "clip.mp4")), "type_blocked");
  assert.equal(canOpen("A.PNG", "image"), true); assert.equal(canOpen("a.png", "text"), false); assert.equal(canOpen("a.svg", "image"), false);
});

test("the command line reader speaks one JSON line and exits non-zero with only a safe code", () => {
  const run = spawnSync(process.execPath, ["docker/desktop/outbox-reader.mjs", "list", JSON.stringify({ known: [] })], { env: { ...process.env, HOME: tmpdir() }, encoding: "utf8" });
  assert.equal(run.status, 3); assert.deepEqual(JSON.parse(run.stdout), { error: "scan_failed" }); assert.equal(run.stderr, "");
  const bad = spawnSync(process.execPath, ["docker/desktop/outbox-reader.mjs", "read", "not json"], { env: { ...process.env, HOME: tmpdir() }, encoding: "utf8" });
  assert.equal(bad.status, 3); assert.deepEqual(JSON.parse(bad.stdout), { error: "scan_failed" });
});
