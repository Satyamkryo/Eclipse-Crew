import { constants } from "node:fs";
import { open, lstat, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { classifyZip, detectKind, HEAD_BYTES, isBlockedName, listZipEntries } from "./inbox-writer.mjs";

// Runs as the agent's own Linux user. Lists and reads files the agent wrote to its outbox/. Everything in the
// outbox is untrusted: only regular, single-link files with a plain name are ever listed, hashed or sent.
export class OutboxError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = (code) => { throw new OutboxError(code); };
export const MAX_ENTRIES = 1000;
export const MAX_NEW_PER_SCAN = 5;
export const MAX_FILE_BYTES = 1024 ** 3;
const SETTLE_MS = 2000;
const CHUNK = 1024 * 1024;
// Keep identical to lib/chat/file-types.ts (a test compares the two).
export const OPENABLE = {
  image: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif"],
  pdf: [".pdf"],
  audio: [".mp3", ".wav", ".ogg", ".flac", ".m4a"],
  video: [".webm", ".ogv"],
  text: [".txt", ".md", ".csv", ".json", ".log"],
};

export function isPlainName(name) {
  return typeof name === "string" && name.length > 0 && Buffer.byteLength(name) <= 255 && name === name.trim() && !name.startsWith(".") &&
    !/[\u0000-\u001f\u007f-\u009f/\\]/.test(name) && name.isWellFormed() && name.normalize("NFC") === name;
}
export function canOpen(name, kind) {
  const extension = path.posix.extname(name).toLowerCase();
  return Object.hasOwn(OPENABLE, kind) && OPENABLE[kind].includes(extension);
}

async function inspect(outbox, name, { hash }) {
  if (!isPlainName(name) || isBlockedName(name)) return null;
  const full = path.join(outbox, name);
  let before; try { before = await lstat(full); } catch { return null; }
  if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_FILE_BYTES) return null;
  let file; try { file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return null; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size) return null;
    const head = Buffer.alloc(Math.min(HEAD_BYTES, stat.size));
    await file.read(head, 0, head.length, 0);
    let kind; try { kind = detectKind(head); } catch { return null; }
    if (kind === "zip") { try { kind = classifyZip(await listZipEntries(file, stat.size), path.posix.extname(name)); } catch { return null; } }
    const entry = { name, size: stat.size, kind, mtimeMs: stat.mtimeMs };
    if (hash) entry.sha256 = await hashFile(file, stat.size);
    return entry;
  } finally { await file.close().catch(() => {}); }
}
async function hashFile(file, size) {
  const digest = createHash("sha256"); const buffer = Buffer.alloc(CHUNK);
  for (let at = 0; at < size;) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(CHUNK, size - at), at);
    if (bytesRead === 0) fail("file_changed");
    digest.update(buffer.subarray(0, bytesRead)); at += bytesRead;
  }
  return digest.digest("hex");
}
async function checkOutbox(outbox) {
  let stat; try { stat = await lstat(outbox); } catch { fail("scan_failed"); }
  if (!stat.isDirectory() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) fail("scan_failed");
}

// known: [name, size] pairs that already have a card. Returns only new, settled files (at most 5 per scan, oldest first).
export async function listOutbox({ outbox, known = [], now = Date.now() }) {
  await checkOutbox(outbox);
  const index = new Map(known.map(([name, size]) => [name, size]));
  let names; try { names = await readdir(outbox); } catch { return fail("scan_failed"); }
  if (names.length > MAX_ENTRIES) names = names.slice(0, MAX_ENTRIES);
  const fresh = [];
  for (const name of names) {
    if (!isPlainName(name) || isBlockedName(name)) continue;
    let stat; try { stat = await lstat(path.join(outbox, name)); } catch { continue; }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > MAX_FILE_BYTES || index.get(name) === stat.size) continue;
    fresh.push({ name, mtimeMs: stat.mtimeMs });
  }
  fresh.sort((left, right) => left.mtimeMs - right.mtimeMs || (left.name < right.name ? -1 : 1));
  const files = []; let pending = 0;
  for (const candidate of fresh) {
    if (now - candidate.mtimeMs < SETTLE_MS || files.length >= MAX_NEW_PER_SCAN) { pending += 1; continue; }
    const entry = await inspect(outbox, candidate.name, { hash: true });
    if (entry) files.push({ name: entry.name, size: entry.size, kind: entry.kind, sha256: entry.sha256 });
  }
  return { files, pending };
}

// Checks the file still matches its card before sending a single byte, then streams it.
export async function readOutbox({ outbox, name, sha256, size, write }) {
  await checkOutbox(outbox);
  if (!isPlainName(name) || isBlockedName(name)) fail("file_not_found");
  const full = path.join(outbox, name);
  let before; try { before = await lstat(full); } catch { return fail("file_not_found"); }
  if (!before.isFile() || before.nlink !== 1) fail("file_not_found");
  if (before.size !== size) fail("file_changed");
  let file; try { file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return fail("file_not_found"); }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== size) fail("file_changed");
    if (await hashFile(file, size) !== sha256) fail("file_changed");
    await write(`${JSON.stringify({ size })}\n`);
    const buffer = Buffer.alloc(CHUNK);
    for (let at = 0; at < size;) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(CHUNK, size - at), at);
      if (bytesRead === 0) fail("download_failed");
      await write(Buffer.from(buffer.subarray(0, bytesRead))); at += bytesRead;
    }
  } finally { await file.close().catch(() => {}); }
}

// Used by the desktop session worker for "Open on the agent's desktop": a plain, single-link, regular file of a
// kind the browser can show safely. Returns the kind, or throws.
export async function checkOpenable(outbox, name) {
  const entry = await inspect(outbox, name, { hash: false });
  if (!entry) fail("file_not_found");
  if (!canOpen(entry.name, entry.kind)) fail("type_blocked");
  return entry;
}

const SAFE = new Set(["file_not_found", "file_changed", "scan_failed", "download_failed", "type_blocked"]);
async function main() {
  const out = (value) => new Promise((resolve, reject) => process.stdout.write(value, (error) => error ? reject(error) : resolve()));
  let started = false;
  try {
    const mode = process.argv[2]; const params = JSON.parse(process.argv[3] ?? "");
    const home = process.env.HOME ?? "";
    if (!/^\/workspace\/homes\/[0-9a-f-]{36}$/.test(home) || !["list", "read"].includes(mode)) fail("scan_failed");
    const outbox = `${home}/outbox`;
    if (mode === "list") {
      if (!Array.isArray(params.known) || !params.known.every((pair) => Array.isArray(pair) && typeof pair[0] === "string" && Number.isSafeInteger(pair[1]))) fail("scan_failed");
      await out(`${JSON.stringify(await listOutbox({ outbox, known: params.known }))}\n`);
    } else {
      if (typeof params.name !== "string" || !/^[0-9a-f]{64}$/.test(params.sha256 ?? "") || !Number.isSafeInteger(params.size)) fail("scan_failed");
      await readOutbox({ outbox, name: params.name, sha256: params.sha256, size: params.size, write: (value) => { started = true; return out(value); } });
    }
  } catch (error) {
    // After the first byte of a download the error is signalled only by exiting short; no text may mix into the file.
    if (!started) { try { await out(`${JSON.stringify({ error: SAFE.has(error?.code) ? error.code : "scan_failed" })}\n`); } catch { /* reader gone */ } }
    process.exitCode = 3;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
