import { constants } from "node:fs";
import { link, lstat, open, readdir, readlink, unlink } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { classifyZip, detectKind, HEAD_BYTES, isBlockedName, listZipEntries } from "./inbox-writer.mjs";
import { isPlainName, MAX_FILE_BYTES } from "./outbox-reader.mjs";

// TASK-067. Runs as the agent's own Linux user (like outbox-reader.mjs). Lists the agent's files, reads text out of
// an inbox attachment, and copies a download or work file into outbox/. Everything it touches is untrusted data:
// it only opens plain-named, regular, single-link files with O_NOFOLLOW and never executes any content.
export class ToolError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = (code) => { throw new ToolError(code); };

export const MAX_WINDOW_CHARS = 60_000;
export const MAX_LIST = 50;
export const MAX_DOCUMENT_BYTES = 50 * 1024 ** 2;
// 4 MiB so the base64 answer (about 5.6 MB) stays under the app's 6 MiB desktop response cap.
export const MAX_IMAGE_BYTES = 4 * 1024 ** 2;
export const MAX_TEXT_CHARS = 5_000_000;
export const MAX_PDF_PAGES = 1000;
const MAX_SCAN = 200;
const CHUNK = 1024 * 1024;
const DOCX_MEMBER = "word/document.xml";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// A file extension that promises a type must match the content (a script renamed .pdf is refused).
const EXPECTED_KIND = new Map([[".pdf", "pdf"], [".png", "image"], [".jpg", "image"], [".jpeg", "image"], [".gif", "image"], [".webp", "image"],
  [".docx", "document"], [".xlsx", "document"], [".pptx", "document"]]);

// `layout` lets tests point the same code at temporary directories; production always derives it from HOME.
export function areas(home) {
  const id = path.basename(home);
  if (!UUID.test(id) || home !== `/workspace/homes/${id}`) fail("scan_failed");
  // Downloads is a symlink to the agent's download directory; its target is checked, then used directly.
  return { inbox: { dir: `${home}/inbox` }, work: { dir: `${home}/work` }, downloads: { dir: `/downloads/${id}`, alias: `${home}/Downloads` }, outbox: { dir: `${home}/outbox` } };
}
async function checkDir(area) {
  if (area.alias) {
    let target; try { target = await readlink(area.alias); } catch { fail("scan_failed"); }
    if (target !== area.dir) fail("scan_failed");
  }
  let stat; try { stat = await lstat(area.dir); } catch { return fail("scan_failed"); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) fail("scan_failed");
}

// Opens one regular, single-link file by plain name and proves it is the file that was inspected.
async function openRegular(dir, name, maxBytes) {
  if (!isPlainName(name)) fail("file_not_found");
  const full = path.join(dir, name);
  let before; try { before = await lstat(full); } catch { return fail("file_not_found"); }
  if (!before.isFile() || before.nlink !== 1 || before.size < 1) fail("file_not_found");
  if (before.size > maxBytes) fail("file_too_large");
  let file; try { file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return fail("file_not_found"); }
  const stat = await file.stat();
  if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size) { await file.close().catch(() => {}); fail("file_not_found"); }
  return { file, stat };
}
async function head(file, size) {
  const buffer = Buffer.alloc(Math.min(HEAD_BYTES, size));
  await file.read(buffer, 0, buffer.length, 0);
  return buffer;
}
async function kindOf(file, size, name) {
  const first = await head(file, size);
  let kind = detectKind(first);
  if (kind === "zip") kind = classifyZip(await listZipEntries(file, size), path.posix.extname(name));
  return { kind, first };
}
async function readAll(file, size) {
  const buffer = Buffer.alloc(size);
  for (let at = 0; at < size;) {
    const { bytesRead } = await file.read(buffer, at, Math.min(CHUNK, size - at), at);
    if (bytesRead === 0) fail("file_not_found");
    at += bytesRead;
  }
  return buffer;
}

export async function listFiles({ home, layout }) {
  const places = layout ?? areas(home);
  const files = [];
  for (const area of ["inbox", "downloads", "work"]) {
    try { await checkDir(places[area]); } catch { continue; }
    let names; try { names = await readdir(places[area].dir); } catch { continue; }
    for (const name of names.slice(0, MAX_SCAN)) {
      if (!isPlainName(name)) continue;
      let stat; try { stat = await lstat(path.join(places[area].dir, name)); } catch { continue; }
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1) continue;
      files.push({ area, name, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  files.sort((left, right) => right.mtimeMs - left.mtimeMs || (left.name < right.name ? -1 : 1));
  const result = [];
  for (const entry of files.slice(0, MAX_LIST)) {
    let kind = "unknown";
    try {
      const { file, stat } = await openRegular(places[entry.area].dir, entry.name, MAX_FILE_BYTES);
      try { kind = (await kindOf(file, stat.size, entry.name)).kind; } catch { kind = "blocked"; } finally { await file.close().catch(() => {}); }
    } catch { continue; }
    result.push({ area: entry.area, name: entry.name, size: entry.size, kind });
  }
  return { files: result };
}

// ---- text extraction -------------------------------------------------------------------------------------------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
export function docxXmlToText(xml) {
  return xml
    .replace(/<w:tab\b[^>]*\/>/g, "\t").replace(/<w:(?:br|cr)\b[^>]*\/>/g, "\n").replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g, (match, body) => {
      if (body[0] !== "#") return ENTITIES[body];
      const code = body[1] === "x" ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
    })
    .replace(/\n{3,}/g, "\n\n").trim();
}
function unzipMember(full, member) {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/unzip", ["-p", full, member], { timeout: 20_000, maxBuffer: 40 * 1024 ** 2, encoding: "buffer", env: {} }, (error, stdout) =>
      error ? reject(new ToolError("document_unreadable")) : resolve(stdout));
  });
}
let pdfModule;
async function loadPdf() { return pdfModule ??= await import("pdfjs-dist/legacy/build/pdf.mjs"); }
export async function pdfToText(data) {
  const pdf = await loadPdf();
  let doc;
  try {
    doc = await pdf.getDocument({ data: new Uint8Array(data), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0,
      enableXfa: false, stopAtErrors: false }).promise;
  } catch { return fail("document_unreadable"); }
  try {
    const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
    let text = ""; let truncated = doc.numPages > pages;
    for (let number = 1; number <= pages; number++) {
      const content = await (await doc.getPage(number)).getTextContent();
      let line = "";
      for (const item of content.items) { if (typeof item.str === "string") line += item.str; if (item.hasEOL) line += "\n"; }
      text += `${line.trim()}\n\n`;
      if (text.length > MAX_TEXT_CHARS) { text = text.slice(0, MAX_TEXT_CHARS); truncated = true; break; }
    }
    return { text: text.trim(), truncated };
  } catch { return fail("document_unreadable"); } finally { await doc.destroy().catch(() => {}); }
}
function imageMime(first) {
  if (first.length >= 8 && first.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (first.length >= 3 && first[0] === 0xff && first[1] === 0xd8 && first[2] === 0xff) return "image/jpeg";
  if (first.length >= 12 && first.toString("latin1", 0, 4) === "RIFF" && first.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

// Cuts one window without splitting a surrogate pair. Offsets and lengths are UTF-16 code units.
export function windowText(text, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length || (offset === text.length && text.length > 0)) fail("invalid_offset");
  let end = Math.min(text.length, offset + MAX_WINDOW_CHARS);
  if (end < text.length) { const last = text.charCodeAt(end - 1); if (last >= 0xd800 && last <= 0xdbff) end -= 1; }
  return { text: text.slice(offset, end), offset, nextOffset: end < text.length ? end : null, totalChars: text.length };
}

export async function readDocument({ home, name, offset = 0, layout }) {
  const places = layout ?? areas(home);
  await checkDir(places.inbox);
  const { file, stat } = await openRegular(places.inbox.dir, name, MAX_DOCUMENT_BYTES);
  try {
    const { kind, first } = await kindOf(file, stat.size, name);
    const extension = path.posix.extname(name).toLowerCase();
    if (kind === "image") {
      const mime = imageMime(first);
      if (!mime) fail("unsupported_type");
      if (stat.size > MAX_IMAGE_BYTES) fail("file_too_large");
      return { kind: "image", mime, size: stat.size, base64: (await readAll(file, stat.size)).toString("base64") };
    }
    let text; let truncated = false; let format;
    if (kind === "text") {
      format = "text";
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(await readAll(file, stat.size)); } catch { return fail("document_unreadable"); }
    } else if (kind === "pdf") {
      format = "pdf";
      ({ text, truncated } = await pdfToText(await readAll(file, stat.size)));
      if (text.replace(/\s/g, "").length < 1) fail("no_text_layer");
    } else if (kind === "document" && extension === ".docx") {
      format = "docx";
      const names = await listZipEntries(file, stat.size);
      if (!names || !names.includes(DOCX_MEMBER)) fail("document_unreadable");
      text = docxXmlToText((await unzipMember(path.join(places.inbox.dir, name), DOCX_MEMBER)).toString("utf8"));
      if (text.length < 1) fail("document_unreadable");
    } else return fail("unsupported_type");
    if (text.length > MAX_TEXT_CHARS) { text = text.slice(0, MAX_TEXT_CHARS); truncated = true; }
    if (text.length === 0) fail("document_unreadable");
    return { kind: "text", format, truncated, ...windowText(text, offset) };
  } finally { await file.close().catch(() => {}); }
}

// ---- delivery --------------------------------------------------------------------------------------------------

function numbered(name, index) {
  if (index === 0) return name;
  const extension = path.posix.extname(name); const stem = extension ? name.slice(0, -extension.length) : name;
  return `${stem} (${index + 1})${extension}`;
}
export async function deliverFile({ home, from, name, layout }) {
  const places = layout ?? areas(home);
  if (from !== "downloads" && from !== "work") fail("file_not_found");
  if (isBlockedName(name)) fail("type_blocked");
  await checkDir(places[from]); await checkDir(places.outbox);
  const { file, stat } = await openRegular(places[from].dir, name, MAX_FILE_BYTES);
  const temp = path.join(places.outbox.dir, `.${randomBytes(16).toString("hex")}.part`);
  let target; let output;
  try {
    const { kind } = await kindOf(file, stat.size, name);
    const wanted = EXPECTED_KIND.get(path.posix.extname(name).toLowerCase());
    if (wanted && wanted !== kind) fail("type_blocked");
    output = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const digest = createHash("sha256"); const buffer = Buffer.alloc(CHUNK);
    for (let at = 0; at < stat.size;) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(CHUNK, stat.size - at), at);
      if (bytesRead === 0) fail("file_not_found");
      digest.update(buffer.subarray(0, bytesRead));
      await output.write(buffer, 0, bytesRead); at += bytesRead;
    }
    await output.close(); output = undefined;
    for (let index = 0; index < 100; index++) {
      const candidate = numbered(name, index);
      if (Buffer.byteLength(candidate) > 255) fail("deliver_failed");
      try { await link(temp, path.join(places.outbox.dir, candidate)); target = candidate; break; }
      catch (error) { if (error?.code !== "EEXIST") fail("deliver_failed"); }
    }
    if (!target) fail("deliver_failed");
    return { name: target, size: stat.size, kind, sha256: digest.digest("hex") };
  } finally {
    await output?.close().catch(() => {});
    await unlink(temp).catch(() => {});
    await file.close().catch(() => {});
  }
}

// ---- command line ----------------------------------------------------------------------------------------------

const SAFE = new Set(["file_not_found", "file_too_large", "type_blocked", "unsupported_type", "no_text_layer", "document_unreadable",
  "invalid_offset", "deliver_failed", "scan_failed", "empty_file"]);
async function main() {
  const out = (value) => new Promise((resolve, reject) => process.stdout.write(value, (error) => error ? reject(error) : resolve()));
  try {
    const mode = process.argv[2]; const params = JSON.parse(process.argv[3] ?? "");
    const home = process.env.HOME ?? "";
    if (!/^\/workspace\/homes\/[0-9a-f-]{36}$/.test(home) || !params || typeof params !== "object") fail("scan_failed");
    let result;
    if (mode === "list") result = await listFiles({ home });
    else if (mode === "read") result = await readDocument({ home, name: params.name, offset: params.offset ?? 0 });
    else if (mode === "deliver") result = await deliverFile({ home, from: params.from, name: params.name });
    else fail("scan_failed");
    await out(`${JSON.stringify({ result })}\n`);
  } catch (error) {
    try { await out(`${JSON.stringify({ error: SAFE.has(error?.code) ? error.code : "scan_failed" })}\n`); } catch { /* reader gone */ }
    process.exitCode = 3;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
