import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { classifyZip, detectKind, listZipEntries, sanitizeName, writeInbox } from "../docker/desktop/inbox-writer.mjs";

const POSIX = process.platform !== "win32";
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
async function inbox(t) {
  const root = await mkdtemp(path.join(tmpdir(), "inbox-"));
  const directory = path.join(root, "inbox");
  await mkdir(directory, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return directory;
}
const chunks = (buffer, size = 65536) => Readable.from((function* () { for (let at = 0; at < buffer.length; at += size) yield buffer.subarray(at, at + size); })());
const write = (directory, rawName, buffer, extra = {}) => writeInbox({ stream: chunks(buffer), inbox: directory, rawName, expected: buffer.length, limit: 16 * 1024 * 1024, ...extra });
const code = async (promise) => { try { await promise; } catch (error) { return error.code; } return "no error"; };
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(2000)]);
const text = (size) => Buffer.from("line of ordinary text ünïcode\n".repeat(Math.ceil(size / 30))).subarray(0, size);

function zip(entries) {
  const locals = []; const central = []; let offset = 0;
  for (const [name, content = ""] of entries) {
    const nameBytes = Buffer.from(name); const data = Buffer.from(content);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt32LE(data.length, 20); header.writeUInt32LE(data.length, 24); header.writeUInt16LE(nameBytes.length, 28); header.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data); central.push(header, nameBytes); offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test("names lose paths, control and direction characters; leading dots and reserved names are refused", () => {
  const name = (raw) => { const { stem, extension } = sanitizeName(raw); return `${stem}${extension}`; };
  assert.equal(name("../../etc/passwd"), "passwd");
  assert.equal(name("..\\..\\Windows\\win.ini"), "win.ini");
  assert.equal(name("report.pdf"), "report.pdf");
  assert.equal(name("a\u0000b\u202ec.txt"), "abc.txt");
  assert.equal(name("what?*.txt"), "what__.txt");
  assert.equal(name("trailing. . "), "trailing");
  assert.equal(name("e\u0301.txt"), "\u00e9.txt");
  const long = name(`${"é".repeat(300)}.txt`);
  assert.ok(Buffer.byteLength(long) <= 200 && long.endsWith(".txt"));
  for (const bad of ["", "..", "...", ".bashrc", "..hidden.txt", "CON.txt", "nul", "COM1.log", "lpt9", "/", "a/", "\u0000", "\ud800.txt", 5, null]) assert.equal(assertCode(() => sanitizeName(bad)), "name_invalid", String(bad));
  for (const blocked of ["x.exe", "x.EXE", "x.dll", "x.msi", "x.bat", "x.cmd", "x.ps1", "x.vbs", "x.wsf", "x.hta", "x.scr", "x.lnk", "x.sh", "x.apk", "x.jar", "x.docm", "photo.png.exe"])
    assert.equal(assertCode(() => sanitizeName(blocked)), "type_blocked", blocked);
  for (const allowed of ["script.py", "app.js", "data.csv", "notes.md", "archive.tar.gz", "a.b.c.txt"]) assert.doesNotThrow(() => sanitizeName(allowed), allowed);
});
function assertCode(fn) { try { fn(); } catch (error) { return error.code; } return "no error"; }

test("content decides the kind: known formats are accepted, programs, shell scripts, legacy Office and unknown binaries are not", () => {
  const png8 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  assert.equal(detectKind(png8), "image");
  assert.equal(detectKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), "image");
  assert.equal(detectKind(Buffer.from("GIF89a....")), "image");
  assert.equal(detectKind(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])), "image");
  assert.equal(detectKind(Buffer.from("%PDF-1.7\n")), "pdf");
  assert.equal(detectKind(Buffer.from("ID3\x04")), "audio");
  assert.equal(detectKind(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypM4A ")])), "audio");
  assert.equal(detectKind(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom")])), "video");
  assert.equal(detectKind(Buffer.from([0x1f, 0x8b, 8, 0])), "archive");
  assert.equal(detectKind(Buffer.from("PK\x03\x04")), "zip");
  assert.equal(detectKind(Buffer.from("plain notes, with ünïcode\r\n\tand tabs")), "text");
  assert.equal(detectKind(Buffer.from("MZ is just how this note begins")), "text");
  const pe = Buffer.alloc(128); pe.write("MZ"); pe.writeUInt32LE(64, 0x3c); pe.write("PE\0\0", 64, "binary");
  for (const blocked of [Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]), pe, Buffer.from("#!/bin/sh\necho hi\n"), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]),
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0]), Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0]), Buffer.from("dex\n035\0"), Buffer.from([1, 2, 3, 0, 5, 6]), Buffer.from("tab\u0000nul"),
    Buffer.from([0xc3, 0x28, 0x41])]) assert.equal(assertCode(() => detectKind(blocked)), "type_blocked");
  assert.equal(assertCode(() => detectKind(Buffer.alloc(0))), "empty_file");
});

test("a stored file is byte-identical, mode 600, hashed, and leaves no partial file", async (t) => {
  const directory = await inbox(t); const body = Buffer.concat([png(), randomBytes(5 * 1024 * 1024)]);
  const result = await write(directory, "Screen shot.png", body);
  assert.deepEqual(Object.keys(result).sort(), ["kind", "sha256", "size", "storedName"]);
  assert.equal(result.storedName, "Screen shot.png"); assert.equal(result.kind, "image"); assert.equal(result.size, body.length); assert.equal(result.sha256, sha(body));
  assert.equal(sha(await readFile(path.join(directory, result.storedName))), result.sha256);
  assert.deepEqual(await readdir(directory), ["Screen shot.png"]);
  if (POSIX) assert.equal((await stat(path.join(directory, result.storedName))).mode & 0o777, 0o600);
});

test("a name that already exists gets a numbered suffix and the old file is never overwritten", async (t) => {
  const directory = await inbox(t);
  await writeFile(path.join(directory, "notes.txt"), "original");
  const first = await write(directory, "notes.txt", text(100)); const second = await write(directory, "notes.txt", text(100));
  assert.equal(first.storedName, "notes (1).txt"); assert.equal(second.storedName, "notes (2).txt");
  assert.equal(await readFile(path.join(directory, "notes.txt"), "utf8"), "original");
  assert.deepEqual((await readdir(directory)).sort(), ["notes (1).txt", "notes (2).txt", "notes.txt"]);
});

test("a blocked type is refused before any bytes are stored, even for a large body", async (t) => {
  const directory = await inbox(t); let pulled = 0;
  const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(4 * 1024 * 1024, 1)]);
  const stream = Readable.from((async function* () { for (let at = 0; at < elf.length; at += 65536) { pulled += 1; yield elf.subarray(at, at + 65536); } })());
  assert.equal(await code(writeInbox({ stream, inbox: directory, rawName: "harmless.txt", expected: elf.length, limit: elf.length })), "type_blocked");
  assert.deepEqual(await readdir(directory), []);
  assert.ok(pulled < 40, `stopped reading early (${pulled} chunks)`);
  assert.equal(await code(write(directory, "tool.exe", text(10))), "type_blocked");
  assert.deepEqual(await readdir(directory), []);
});

test("size problems leave nothing behind: over the limit, longer than declared, shorter than declared, empty", async (t) => {
  const directory = await inbox(t); const body = text(100_000);
  assert.equal(await code(writeInbox({ stream: chunks(body), inbox: directory, rawName: "a.txt", expected: body.length, limit: body.length - 1 })), "file_too_large");
  assert.equal(await code(writeInbox({ stream: chunks(body), inbox: directory, rawName: "a.txt", expected: body.length - 1, limit: body.length })), "incomplete_upload");
  assert.equal(await code(writeInbox({ stream: chunks(body.subarray(0, 50_000)), inbox: directory, rawName: "a.txt", expected: body.length, limit: body.length })), "incomplete_upload");
  assert.equal(await code(writeInbox({ stream: chunks(Buffer.alloc(0)), inbox: directory, rawName: "a.txt", expected: 0, limit: 10 })), "empty_file");
  assert.equal(await code(writeInbox({ stream: chunks(Buffer.alloc(0)), inbox: directory, rawName: "a.txt", expected: 5, limit: 10 })), "empty_file");
  assert.deepEqual(await readdir(directory), []);
  const large = Buffer.concat([png(), Buffer.alloc(300_000, 7)]);
  assert.equal(await code(writeInbox({ stream: chunks(large.subarray(0, 200_000)), inbox: directory, rawName: "late.png", expected: large.length, limit: large.length })), "incomplete_upload");
  assert.deepEqual(await readdir(directory), [], "a partly written file is removed");
});

test("a stalled or broken stream is abandoned and its partial file removed", async (t) => {
  const directory = await inbox(t); const head = png();
  const stalled = Readable.from((async function* () { yield head; await new Promise(() => {}); })());
  assert.equal(await code(writeInbox({ stream: stalled, inbox: directory, rawName: "stall.png", expected: head.length + 10, limit: 1 << 20, idleMs: 80 })), "incomplete_upload");
  const broken = new Readable({ read() { this.push(head.subarray(0, 100)); setImmediate(() => this.destroy(new Error("reset"))); } });
  assert.equal(await code(writeInbox({ stream: broken, inbox: directory, rawName: "reset.png", expected: head.length, limit: 1 << 20 })), "incomplete_upload");
  assert.deepEqual(await readdir(directory), []);
});

test("text must be valid UTF-8 for the whole file, not just the first 8 KiB", async (t) => {
  const directory = await inbox(t);
  const body = Buffer.concat([text(20_000), Buffer.from([0xc3, 0x28]), text(1000)]);
  assert.equal(await code(write(directory, "late.txt", body)), "type_blocked");
  const nul = Buffer.concat([text(20_000), Buffer.from([0]), text(10)]);
  assert.equal(await code(write(directory, "zero-byte.txt", nul)), "type_blocked");
  const cut = Buffer.concat([text(20_000), Buffer.from([0xe2, 0x82])]);
  assert.equal(await code(write(directory, "cut.txt", cut)), "type_blocked");
  assert.deepEqual(await readdir(directory), []);
  const multibyte = Buffer.from("é".repeat(20_000));
  assert.equal((await write(directory, "wide.txt", multibyte, { })).kind, "text");
});

test("ZIP files are classified from the central directory: archive, document, or blocked for programs and macros", async (t) => {
  const directory = await inbox(t);
  const stored = async (name, entries) => (await write(directory, name, zip(entries))).kind;
  assert.equal(await stored("things.zip", [["a.txt", "hello"], ["b/c.txt", "x"]]), "archive");
  assert.equal(await stored("letter.docx", [["[Content_Types].xml", "<x/>"], ["word/document.xml", "<w/>"]]), "document");
  assert.equal(await stored("sheet.ods", [["mimetype", "application/vnd.oasis.opendocument.spreadsheet"], ["META-INF/manifest.xml", "<m/>"], ["content.xml", "<c/>"]]), "document");
  for (const [name, entries] of [
    ["macro.docx", [["[Content_Types].xml", "<x/>"], ["word/vbaProject.bin", "bin"]]],
    ["app.zip", [["AndroidManifest.xml", "<m/>"], ["classes.dex", "dex"]]],
    ["lib.zip", [["META-INF/MANIFEST.MF", "Manifest"], ["A.class", "c"]]],
    ["odf.odt", [["mimetype", "x"], ["META-INF/manifest.xml", "<m/>"], ["Basic/Standard/Module1.xml", "sub"]]],
  ]) assert.equal(await code(write(directory, name, zip(entries))), "type_blocked", name);
  const damaged = Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(100)]);
  assert.equal((await write(directory, "damaged.zip", damaged)).kind, "archive");
  assert.equal(await code(write(directory, "damaged.docx", damaged)), "type_blocked");
  const zip64 = zip([["a.txt", "x"]]);
  zip64.writeUInt32LE(0xffffffff, zip64.length - 22 + 16);
  await writeFile(path.join(directory, "zip64.bin"), zip64);
  const handle = await open(path.join(directory, "zip64.bin"), "r");
  try { assert.equal(await listZipEntries(handle, zip64.length), null); } finally { await handle.close(); }
  assert.equal(classifyZip(null, ".zip"), "archive");
  assert.equal(assertCode(() => classifyZip(null, ".DOCX")), "type_blocked");
  assert.equal(assertCode(() => classifyZip(null, ".jar")), "type_blocked");
});

test("a symlink planted as the inbox, or as the target name, is never followed", { skip: !POSIX }, async (t) => {
  const directory = await inbox(t); const outside = path.join(path.dirname(directory), "outside"); await mkdir(outside);
  await symlink(outside, path.join(path.dirname(directory), "link"));
  assert.equal(await code(write(path.join(path.dirname(directory), "link"), "a.txt", text(50))), "upload_failed");
  await symlink(path.join(outside, "victim.txt"), path.join(directory, "planted.txt"));
  const result = await write(directory, "planted.txt", text(50));
  assert.equal(result.storedName, "planted (1).txt");
  assert.deepEqual(await readdir(outside), [], "nothing was written through the symlink");
});

test("stale partial files from a killed writer are swept, fresh ones are left alone", async (t) => {
  const directory = await inbox(t);
  const stale = path.join(directory, `.${"a".repeat(32)}.part`); const fresh = path.join(directory, `.${"b".repeat(32)}.part`); const other = path.join(directory, ".keep.part");
  for (const file of [stale, fresh, other]) await writeFile(file, "partial");
  const old = new Date(Date.now() - 2 * 3600 * 1000); await utimes(stale, old, old); await utimes(other, old, old);
  await write(directory, "ok.txt", text(10));
  assert.deepEqual((await readdir(directory)).sort(), [`.${"b".repeat(32)}.part`, ".keep.part", "ok.txt"].sort());
});

test("the command line entry point reports only a safe code when it is not run inside an agent home", () => {
  const run = spawnSync(process.execPath, ["docker/desktop/inbox-writer.mjs", JSON.stringify({ name: "a.txt", expected: 3, limit: 10 })], { input: "abc", env: { ...process.env, HOME: tmpdir() }, encoding: "utf8" });
  assert.equal(run.status, 3);
  assert.deepEqual(JSON.parse(run.stdout), { error: "upload_failed" });
  assert.equal(run.stderr, "");
});

test("more common formats are accepted by their content, and look-alikes are not", () => {
  const bmp = Buffer.alloc(30); bmp.write("BM"); bmp.writeUInt32LE(40, 14);
  const ftyp = (brand) => Buffer.concat([Buffer.alloc(4), Buffer.from(`ftyp${brand}`), Buffer.alloc(8)]);
  const cases = [
    ["image", bmp], ["image", Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0])], ["image", Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8])],
    ["image", Buffer.from([0, 0, 1, 0, 2, 0, 16, 16, 0, 0])], ["image", ftyp("heic")], ["image", ftyp("avif")], ["image", ftyp("mif1")],
    ["video", Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9])], ["video", Buffer.from([0x46, 0x4c, 0x56, 1, 5, 0, 0, 0, 9])],
    ["video", Buffer.from([0, 0, 1, 0xba, 0x44, 0])], ["video", Buffer.from([0, 0, 1, 0xb3, 0x14, 0])], ["video", ftyp("isom")], ["video", ftyp("3gp4")],
    ["audio", Buffer.concat([Buffer.from("FORM"), Buffer.alloc(4), Buffer.from("AIFF")])], ["audio", Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1])], ["audio", ftyp("M4A ")],
  ];
  for (const [kind, head] of cases) assert.equal(detectKind(head), kind, head.subarray(0, 12).toString("hex"));
  // Plain text that merely starts like a format stays text.
  for (const note of ["BM is the abbreviation I use for these notes\nmore text here", "FORM letter template, nothing else in it", "MThd is a MIDI marker, said this text", "FLV streams are covered below in this document"])
    assert.equal(detectKind(Buffer.from(note)), "text", note);
  // A BMP header with a made-up size, a bad ICO count, and lookalike signatures with program contents are still refused.
  const oddBmp = Buffer.alloc(30); oddBmp.write("BM"); oddBmp.writeUInt32LE(7, 14);
  for (const refused of [oddBmp, Buffer.from([0, 0, 1, 0, 0, 0, 1, 2]), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 1, 0xba]), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 1, 0xba]), Buffer.from([0, 0, 2, 0, 1, 2, 3])])
    assert.equal(assertCode(() => detectKind(refused)), "type_blocked", refused.subarray(0, 12).toString("hex"));
});

test("a file named like one format but holding another is judged by its content", async (t) => {
  const directory = await inbox(t);
  const bmp = Buffer.alloc(200, 1); bmp.write("BM"); bmp.writeUInt32LE(0, 6); bmp.writeUInt32LE(40, 14);
  assert.equal((await write(directory, "picture.bmp", bmp)).kind, "image");
  assert.equal((await write(directory, "fake.bmp", text(200))).kind, "text");
  assert.equal(await code(write(directory, "fake2.bmp", Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(100)]))), "type_blocked");
});
