import { constants } from "node:fs";
import { open, lstat, link, unlink, readdir } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Runs as the agent's own Linux user. It is the single authority for the stored name, the content type
// and the size of an attachment (docs/SECURITY.md section 7). The caller only supplies bytes and a name hint.
export class InboxError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = (code) => { throw new InboxError(code); };
export const SAFE_WRITER_CODES = new Set(["file_too_large", "type_blocked", "name_invalid", "incomplete_upload", "empty_file", "upload_failed"]);
export const HEAD_BYTES = 8192;
export const MAX_STORED_NAME_BYTES = 200;
const IDLE_MS = 30_000;
const STALE_PART_MS = 60 * 60 * 1000;
const MAX_ZIP_DIRECTORY = 4 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 100_000;
const BLOCKED_EXTENSIONS = new Set([".exe", ".dll", ".msi", ".bat", ".cmd", ".ps1", ".vbs", ".wsf", ".hta", ".scr", ".lnk", ".sh",
  ".apk", ".jar", ".docm", ".xlsm", ".pptm", ".dotm", ".xlsb", ".xlam", ".ppam", ".pif", ".reg", ".jse", ".vbe"]);
// Also used for the agent's outbox: a script is text, so only its name shows it would run when double-clicked.
export const isBlockedName = (name) => BLOCKED_EXTENSIONS.has(path.posix.extname(name).toLowerCase());
const CONTAINER_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp", ".epub", ".jar", ".apk"]);
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const PART_PATTERN = /^\.[0-9a-f]{32}\.part$/;

export function sanitizeName(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1024) fail("name_invalid");
  let name = raw.normalize("NFC");
  if (!name.isWellFormed()) fail("name_invalid");
  name = name.split(/[\\/]/).pop();
  name = name.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g, "");
  name = name.replace(/[<>:"|?*]/g, "_").trim().replace(/[. ]+$/, "");
  // docs/SECURITY.md section 7: leading dots and Windows reserved names are rejected, not rewritten.
  if (!name || name.startsWith(".") || RESERVED.test(name)) fail("name_invalid");
  let extension = path.posix.extname(name);
  if (Buffer.byteLength(extension) > 24) extension = "";
  if (BLOCKED_EXTENSIONS.has(extension.toLowerCase())) fail("type_blocked");
  let stem = extension ? name.slice(0, -extension.length) : name;
  while (Buffer.byteLength(stem) + Buffer.byteLength(extension) > MAX_STORED_NAME_BYTES) stem = Array.from(stem).slice(0, -1).join("");
  stem = stem.replace(/[. ]+$/, "");
  if (!stem) fail("name_invalid");
  return { stem, extension };
}

const startsWith = (head, bytes, offset = 0) => head.length >= offset + bytes.length && bytes.every((byte, index) => head[offset + index] === byte);
const ascii = (head, text, offset = 0) => startsWith(head, [...text].map((char) => char.charCodeAt(0)), offset);

// "MZ" alone is not enough to block: a text file can start with it. Other binaries fail the text check below.
function isPortableExecutable(head) {
  if (!ascii(head, "MZ") || head.length < 0x40) return false;
  const offset = head.readUInt32LE(0x3c);
  return offset + 4 <= head.length && startsWith(head, [0x50, 0x45, 0, 0], offset);
}
const IMAGE_BRANDS = ["heic", "heix", "mif1", "msf1", "avif", "avis"];
// "BM" alone is ordinary text, so a BMP also needs its reserved bytes to be zero and a known header size.
function isBmp(head) {
  return ascii(head, "BM") && head.length >= 18 && head.readUInt32LE(6) === 0 && [12, 40, 52, 56, 64, 108, 124].includes(head.readUInt32LE(14));
}
// Content decides the type. A name or a claimed type never allows anything.
export function detectKind(head) {
  if (head.length === 0) fail("empty_file");
  if (startsWith(head, [0x7f, 0x45, 0x4c, 0x46]) || isPortableExecutable(head) || ascii(head, "#!") || ascii(head, "dex\n") ||
    startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) ||
    [[0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe]].some((magic) => startsWith(head, magic)))
    fail("type_blocked");
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) || startsWith(head, [0xff, 0xd8, 0xff]) || ascii(head, "GIF87a") || ascii(head, "GIF89a") ||
    (ascii(head, "RIFF") && ascii(head, "WEBP", 8)) || isBmp(head) || startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a]) ||
    (startsWith(head, [0, 0, 1, 0]) && head.length >= 6 && head.readUInt16LE(4) >= 1 && head.readUInt16LE(4) <= 255) ||
    (ascii(head, "ftyp", 4) && IMAGE_BRANDS.some((brand) => ascii(head, brand, 8)))) return "image";
  if (head.subarray(0, 1024).includes("%PDF-")) return "pdf";
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) return "zip";
  if (startsWith(head, [0x1f, 0x8b]) || ascii(head, "BZh") || startsWith(head, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) ||
    startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) || ascii(head, "Rar!") || ascii(head, "ustar", 257)) return "archive";
  if (ascii(head, "ID3") || ascii(head, "fLaC") || ascii(head, "OggS") || (ascii(head, "RIFF") && ascii(head, "WAVE", 8)) ||
    (head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && (head[1] & 0x06) !== 0) ||
    (ascii(head, "FORM") && (ascii(head, "AIFF", 8) || ascii(head, "AIFC", 8))) || startsWith(head, [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6])) return "audio";
  if (ascii(head, "ftyp", 4)) return ascii(head, "M4A ", 8) || ascii(head, "M4B ", 8) ? "audio" : "video";
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3]) || (ascii(head, "RIFF") && ascii(head, "AVI ", 8)) || startsWith(head, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]) ||
    startsWith(head, [0x46, 0x4c, 0x56, 0x01]) || startsWith(head, [0, 0, 1, 0xba]) || startsWith(head, [0, 0, 1, 0xb3])) return "video";
  if (isText(head, new TextDecoder("utf-8", { fatal: true }), false)) return "text";
  return fail("type_blocked");
}
const CONTROL = /[\u0000-\u0008\u000b\u000e-\u001f]/;
function isText(chunk, decoder, final) {
  try { return !CONTROL.test(decoder.decode(chunk, { stream: !final })); } catch { return false; }
}

async function readAt(file, buffer, position) {
  let done = 0;
  while (done < buffer.length) {
    const { bytesRead } = await file.read(buffer, done, buffer.length - done, position + done);
    if (bytesRead === 0) fail("type_blocked");
    done += bytesRead;
  }
}
// Reads only the ZIP central directory. Returns entry names, or null for ZIP64/unusual layouts.
export async function listZipEntries(file, size) {
  const tail = Buffer.alloc(Math.min(size, 65557));
  await readAt(file, tail, size - tail.length);
  let end = -1;
  for (let index = tail.length - 22; index >= 0; index--) if (tail.readUInt32LE(index) === 0x06054b50) { end = index; break; }
  if (end < 0) return null;
  const count = tail.readUInt16LE(end + 10); const length = tail.readUInt32LE(end + 12); const offset = tail.readUInt32LE(end + 16);
  if (count === 0xffff || length === 0xffffffff || offset === 0xffffffff) return null;
  if (length > MAX_ZIP_DIRECTORY || offset + length > size || count > MAX_ZIP_ENTRIES) fail("type_blocked");
  const directory = Buffer.alloc(length);
  await readAt(file, directory, offset);
  const names = []; let cursor = 0;
  while (cursor < length) {
    if (cursor + 46 > length || directory.readUInt32LE(cursor) !== 0x02014b50) fail("type_blocked");
    const nameLength = directory.readUInt16LE(cursor + 28); const next = cursor + 46 + nameLength + directory.readUInt16LE(cursor + 30) + directory.readUInt16LE(cursor + 32);
    if (next > length) fail("type_blocked");
    names.push(directory.toString("utf8", cursor + 46, cursor + 46 + nameLength)); cursor = next;
  }
  if (names.length !== count) fail("type_blocked");
  return names;
}
export function classifyZip(names, extension) {
  if (names === null) return CONTAINER_EXTENSIONS.has(extension.toLowerCase()) ? fail("type_blocked") : "archive";
  const lower = names.map((name) => name.toLowerCase());
  if (lower.some((name) => name.endsWith("vbaproject.bin") || name.endsWith(".class") || name === "androidmanifest.xml" || name === "classes.dex" ||
    name === "meta-inf/manifest.mf" || name.startsWith("basic/") || name.startsWith("scripts/") || /(^|\/)(macros?|vba)\//.test(name))) fail("type_blocked");
  if (lower.includes("[content_types].xml") || (lower.includes("mimetype") && lower.includes("meta-inf/manifest.xml"))) return "document";
  return "archive";
}

async function checkInbox(inbox) {
  const stat = await lstat(inbox);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("upload_failed");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) fail("upload_failed");
}
async function sweepStale(inbox) {
  let entries; try { entries = await readdir(inbox); } catch { return; }
  for (const entry of entries) {
    if (!PART_PATTERN.test(entry)) continue;
    try { const stat = await lstat(path.join(inbox, entry)); if (stat.isFile() && Date.now() - stat.mtimeMs > STALE_PART_MS) await unlink(path.join(inbox, entry)); } catch { /* best effort */ }
  }
}

export async function writeInbox({ stream, inbox, rawName, expected, limit, idleMs = IDLE_MS }) {
  const { stem, extension } = sanitizeName(rawName);
  if (!Number.isSafeInteger(expected) || expected < 1) fail("empty_file");
  if (!Number.isSafeInteger(limit) || limit < 1 || expected > limit) fail("file_too_large");
  await checkInbox(inbox);
  await sweepStale(inbox);
  const iterator = stream[Symbol.asyncIterator]();
  let received = 0;
  const next = async () => {
    let timer;
    try {
      const result = await Promise.race([iterator.next(), new Promise((_, reject) => { timer = setTimeout(() => reject(new InboxError("incomplete_upload")), idleMs); })]);
      if (result.done) return null;
      const chunk = Buffer.isBuffer(result.value) ? result.value : Buffer.from(result.value);
      received += chunk.length;
      if (received > expected) fail(received > limit ? "file_too_large" : "incomplete_upload");
      return chunk;
    } catch (error) { throw error instanceof InboxError ? error : new InboxError("incomplete_upload"); } finally { clearTimeout(timer); }
  };
  const held = []; let heldBytes = 0;
  while (heldBytes < HEAD_BYTES) {
    const chunk = await next();
    if (!chunk) break;
    held.push(chunk); heldBytes += chunk.length;
  }
  const first = Buffer.concat(held);
  let kind = detectKind(first.subarray(0, HEAD_BYTES));
  const partName = `.${randomBytes(16).toString("hex")}.part`;
  const partPath = path.join(inbox, partName);
  const file = await open(partPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let finalName; let ok = false;
  try {
    await file.chmod(0o600);
    const hash = createHash("sha256"); const decoder = new TextDecoder("utf-8", { fatal: true });
    const put = async (chunk) => {
      if (kind === "text" && !isText(chunk, decoder, false)) fail("type_blocked");
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) { const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset); offset += bytesWritten; }
    };
    for (const chunk of held) await put(chunk);
    held.length = 0;
    for (let chunk = heldBytes < HEAD_BYTES ? null : await next(); chunk; chunk = await next()) await put(chunk);
    if (received !== expected) fail("incomplete_upload");
    if (kind === "text" && !isText(Buffer.alloc(0), decoder, true)) fail("type_blocked");
    if (kind === "zip") kind = classifyZip(await listZipEntries(file, expected), extension);
    await file.sync();
    for (let attempt = 0; attempt < 1000 && !finalName; attempt++) {
      const candidate = `${stem}${attempt ? ` (${attempt})` : ""}${extension}`;
      try { await link(partPath, path.join(inbox, candidate)); finalName = candidate; } catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    if (!finalName) fail("upload_failed");
    await unlink(partPath);
    const stat = await lstat(path.join(inbox, finalName));
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expected) fail("upload_failed");
    ok = true;
    return { storedName: finalName, size: expected, kind, sha256: hash.digest("hex") };
  } catch (error) {
    if (finalName) { try { await unlink(path.join(inbox, finalName)); } catch { /* best effort */ } }
    throw error instanceof InboxError ? error : new InboxError("upload_failed");
  } finally {
    await file.close().catch(() => {});
    if (!ok) { try { await unlink(partPath); } catch { /* best effort */ } }
  }
}

async function main() {
  try {
    const params = JSON.parse(process.argv[2] ?? "");
    const home = process.env.HOME ?? "";
    if (!/^\/workspace\/homes\/[0-9a-f-]{36}$/.test(home) || typeof params?.name !== "string" || !Number.isSafeInteger(params.expected) || !Number.isSafeInteger(params.limit)) fail("upload_failed");
    const result = await writeInbox({ stream: process.stdin, inbox: `${home}/inbox`, rawName: params.name, expected: params.expected, limit: params.limit });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: SAFE_WRITER_CODES.has(error?.code) ? error.code : "upload_failed" })}\n`);
    process.exitCode = 3;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
