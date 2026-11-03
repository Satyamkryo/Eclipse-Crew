import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, readlink, rename, unlink } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { classifyZip, detectKind, HEAD_BYTES, isBlockedName, listZipEntries } from "./inbox-writer.mjs";
import { isPlainName, MAX_FILE_BYTES } from "./outbox-reader.mjs";
import { buildIndex, searchIndex, validateIndex } from "./doc-search.mjs";

// TASK-067. Runs as the agent's own Linux user (like outbox-reader.mjs). Lists the agent's files, reads text out of
// an inbox attachment, and copies a download or work file into outbox/. Everything it touches is untrusted data:
// it only opens plain-named, regular, single-link files with O_NOFOLLOW and never executes any content.
export class ToolError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = (code) => { throw new ToolError(code); };

export const MAX_WINDOW_CHARS = 20_000;
export const MAX_LIST = 50;
export const MAX_DOCUMENT_BYTES = 50 * 1024 ** 2;
// 4 MiB so the base64 answer (about 5.6 MB) stays under the app's 6 MiB desktop response cap.
export const MAX_IMAGE_BYTES = 4 * 1024 ** 2;
export const MAX_TEXT_CHARS = 5_000_000;
export const MAX_PDF_PAGES = 1000;
const MAX_SCAN = 200;
const CHUNK = 1024 * 1024;
const DOCX_MEMBER = "word/document.xml";
// TASK-082. Derived index cache inside the agent's mode-700 home. Never listed, delivered, checkpointed or restored.
export const INDEX_DIR = ".cache/eclipse/doc-index";
export const MAX_INDEX_FILES = 20;
export const MAX_INDEX_TOTAL_BYTES = 256 * 1024 ** 2;
export const MAX_INDEX_FILE_BYTES = 32 * 1024 ** 2;
export const MAX_XLSX_SHEETS = 50;
export const MAX_XLSX_CELLS = 200_000;
export const MAX_PPTX_SLIDES = 500;
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
// Office XML is decoded as text only: tags are stripped and the same bounded entity table is used. No XML parser means
// no entity expansion and no external entities.
function decodeXmlEntities(xml) {
  return xml.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g, (match, body) => {
    if (body[0] !== "#") return ENTITIES[body];
    const code = body[1] === "x" ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
  });
}
function unzipMember(full, member) {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/unzip", ["-p", full, member], { timeout: 20_000, maxBuffer: 40 * 1024 ** 2, encoding: "buffer", env: {} }, (error, stdout) =>
      error ? reject(new ToolError("document_unreadable")) : resolve(stdout));
  });
}
let pdfModule;
async function loadPdf() { return pdfModule ??= await import("pdfjs-dist/legacy/build/pdf.mjs"); }
// Canvas bounds. Markers are added so read windows, search offsets and page citations all speak about the same text.
export async function pdfToText(data) {
  const pdf = await loadPdf();
  let doc;
  try {
    doc = await pdf.getDocument({ data: new Uint8Array(data), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0,
      enableXfa: false, stopAtErrors: false }).promise;
  } catch { return fail("document_unreadable"); }
  try {
    const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
    let text = ""; let truncated = doc.numPages > pages; let hasText = false;
    const pageStarts = [];
    for (let number = 1; number <= pages; number++) {
      const content = await (await doc.getPage(number)).getTextContent();
      let line = "";
      for (const item of content.items) { if (typeof item.str === "string") line += item.str; if (item.hasEOL) line += "\n"; }
      const body = line.trim();
      if (body.length) hasText = true;
      if (text.length) text += "\n\n";
      pageStarts.push({ offset: text.length, page: number });
      text += `--- page ${number} ---\n${body}`;
      if (text.length > MAX_TEXT_CHARS) { text = text.slice(0, MAX_TEXT_CHARS); truncated = true; break; }
    }
    return { text: text.trim(), truncated, pageStarts, hasText };
  } catch { return fail("document_unreadable"); } finally { await doc.destroy().catch(() => {}); }
}
function imageMime(first) {
  if (first.length >= 8 && first.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (first.length >= 3 && first[0] === 0xff && first[1] === 0xd8 && first[2] === 0xff) return "image/jpeg";
  if (first.length >= 12 && first.toString("latin1", 0, 4) === "RIFF" && first.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

// ---- Office sheets and slides ---------------------------------------------------------------------------------
function columnIndex(reference) {
  const letters = /^([A-Za-z]{1,3})/.exec(reference ?? "")?.[1]?.toUpperCase();
  if (!letters) return null;
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}
const csvCell = (value) => /[",\n\r]/.test(value) ? `"${value.replace(/"/g, "\"\"")}"` : value;
function parseSharedStrings(xml) {
  const shared = [];
  for (const item of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    shared.push(decodeXmlEntities([...item[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => part[1]).join("")));
    if (shared.length >= MAX_XLSX_CELLS) break;
  }
  return shared;
}
function cellValue(attrs, body, shared) {
  const type = /\bt="([^"]*)"/.exec(attrs)?.[1] ?? "";
  if (type === "inlineStr") {
    return decodeXmlEntities([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => part[1]).join(" "));
  }
  const value = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
  if (type === "s") {
    const index = Number.parseInt(value, 10);
    return Number.isSafeInteger(index) && index >= 0 && index < shared.length ? shared[index] : "";
  }
  if (type === "b") return value === "1" ? "TRUE" : "FALSE";
  return decodeXmlEntities(value);
}
// Sheet names come from the workbook in order; sheetN.xml is sheet N. At most 50 sheets and 200,000 cells; past either
// limit the text stops and `truncated` is set.
export async function xlsxToText(readMember) {
  const workbook = decodeXmlEntities((await readMember("xl/workbook.xml")).toString("utf8"));
  const names = [...workbook.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((match) => decodeXmlEntities(match[1]));
  if (!names.length) fail("document_unreadable");
  let shared = [];
  try { shared = parseSharedStrings((await readMember("xl/sharedStrings.xml")).toString("utf8")); } catch { shared = []; }
  let text = ""; let truncated = names.length > MAX_XLSX_SHEETS; let cells = 0;
  const pageStarts = [];
  for (let sheet = 0; sheet < Math.min(names.length, MAX_XLSX_SHEETS); sheet++) {
    if (text.length >= MAX_TEXT_CHARS) { truncated = true; break; }
    let xml;
    try { xml = (await readMember(`xl/worksheets/sheet${sheet + 1}.xml`)).toString("utf8"); } catch { continue; }
    if (text.length) text += "\n";
    const name = names[sheet].replace(/[\u0000-\u001f\u007f-\u009f"]/g, " ").slice(0, 100);
    pageStarts.push({ offset: text.length, page: sheet + 1 });
    text += `--- sheet "${name}" ---\n`;
    let firstRow = true;
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const values = [];
      for (const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        if (cells >= MAX_XLSX_CELLS) { truncated = true; break; }
        cells += 1;
        const column = columnIndex(/\br="([^"]*)"/.exec(cell[1])?.[1]);
        const value = cellValue(cell[1], cell[2] ?? "", shared);
        if (column !== null && column <= 1000) { while (values.length < column) values.push(""); values[column] = value; }
        else values.push(value);
      }
      if (!values.length) continue;
      if (!firstRow) text += "\n";
      firstRow = false;
      text += values.map(csvCell).join(",");
      if (text.length > MAX_TEXT_CHARS) { text = text.slice(0, MAX_TEXT_CHARS); truncated = true; break; }
      if (cells >= MAX_XLSX_CELLS) break;
    }
    if (cells >= MAX_XLSX_CELLS || text.length > MAX_TEXT_CHARS) break;
  }
  return { text: text.trim(), truncated, pageStarts };
}
// Slide text in number order. Speaker notes, charts and images are not read.
export async function pptxToText(readMember, members) {
  const slides = (members ?? [])
    .map((name) => ({ name, number: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0) }))
    .filter((slide) => slide.number > 0)
    .sort((left, right) => left.number - right.number);
  if (!slides.length) fail("document_unreadable");
  let text = ""; let truncated = slides.length > MAX_PPTX_SLIDES;
  const pageStarts = [];
  for (const slide of slides.slice(0, MAX_PPTX_SLIDES)) {
    const xml = (await readMember(slide.name)).toString("utf8");
    const body = [...xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map((match) => decodeXmlEntities(match[1])).join("\n").trim();
    if (text.length) text += "\n\n";
    pageStarts.push({ offset: text.length, page: slide.number });
    text += `--- slide ${slide.number} ---\n${body}`;
    if (text.length > MAX_TEXT_CHARS) { text = text.slice(0, MAX_TEXT_CHARS); truncated = true; break; }
  }
  return { text: text.trim(), truncated, pageStarts };
}

// One extraction for every readable document type. The result feeds both readDocument and the index.
async function extractText({ full, file, stat, kind, extension }) {
  if (kind === "text") {
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(await readAll(file, stat.size)); } catch { return fail("document_unreadable"); }
    return { format: "text", text, truncated: false, pageStarts: [] };
  }
  if (kind === "pdf") {
    const result = await pdfToText(await readAll(file, stat.size));
    if (!result.hasText) fail("no_text_layer");
    return { format: "pdf", ...result };
  }
  if (kind === "document" && extension === ".docx") {
    const names = await listZipEntries(file, stat.size);
    if (!names || !names.includes(DOCX_MEMBER)) fail("document_unreadable");
    const text = docxXmlToText((await unzipMember(full, DOCX_MEMBER)).toString("utf8"));
    if (text.length < 1) fail("document_unreadable");
    return { format: "docx", text, truncated: false, pageStarts: [] };
  }
  if (kind === "document" && extension === ".xlsx") {
    const names = await listZipEntries(file, stat.size);
    if (!names || !names.includes("xl/workbook.xml")) fail("document_unreadable");
    const result = await xlsxToText((member) => unzipMember(full, member));
    if (result.text.length < 1) fail("document_unreadable");
    return { format: "xlsx", ...result };
  }
  if (kind === "document" && extension === ".pptx") {
    const names = await listZipEntries(file, stat.size);
    if (!names || !names.includes("ppt/presentation.xml")) fail("document_unreadable");
    const result = await pptxToText((member) => unzipMember(full, member), names);
    if (result.text.length < 1) fail("document_unreadable");
    return { format: "pptx", ...result };
  }
  return fail("unsupported_type");
}

// ---- index cache -----------------------------------------------------------------------------------------------
// ~/.cache/eclipse/doc-index/<sha256>.json, owned by the agent, 0700/0600, evicted oldest first at 20 files or 256 MB.
// It is derived data outside the checkpoint areas: never listed, delivered, checkpointed or restored.
// A tested home path is the only place production may write; tests and callers without one pass their own directory.
function indexDirFor(home, cacheDir) {
  if (cacheDir) return cacheDir;
  return typeof home === "string" && /^\/workspace\/homes\/[0-9a-f-]{36}$/.test(home) ? path.join(home, INDEX_DIR) : null;
}
export function indexName(sha256) { return `${sha256}.json`; }
async function digestFile(file, size) {
  const hash = createHash("sha256"); const buffer = Buffer.alloc(CHUNK);
  for (let at = 0; at < size;) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(CHUNK, size - at), at);
    if (bytesRead === 0) fail("file_not_found");
    hash.update(buffer.subarray(0, bytesRead)); at += bytesRead;
  }
  return hash.digest("hex");
}
async function loadIndex(dir, sha256, size) {
  if (!dir) return null;
  const full = path.join(dir, indexName(sha256));
  let before; try { before = await lstat(full); } catch { return null; }
  if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_INDEX_FILE_BYTES) return null;
  let handle; try { handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return null; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size) return null;
    const buffer = Buffer.alloc(stat.size);
    for (let at = 0; at < stat.size;) {
      const { bytesRead } = await handle.read(buffer, at, stat.size - at, at);
      if (!bytesRead) return null;
      at += bytesRead;
    }
    let value; try { value = JSON.parse(buffer.toString("utf8")); } catch { return null; }
    const valid = validateIndex(value, { sha256, size });
    return valid && ["text", "pdf", "docx", "xlsx", "pptx"].includes(valid.format) ? valid : null;
  } catch { return null; } finally { await handle.close().catch(() => {}); }
}
async function evictIndexes(dir, keep) {
  let names; try { names = await readdir(dir); } catch { return; }
  const entries = [];
  let total = 0;
  for (const name of names) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
    let stat; try { stat = await lstat(path.join(dir, name)); } catch { continue; }
    if (!stat.isFile()) continue;
    entries.push({ name, size: stat.size, mtimeMs: stat.mtimeMs });
    total += stat.size;
  }
  entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
  while (entries.length > MAX_INDEX_FILES || total > MAX_INDEX_TOTAL_BYTES) {
    const at = entries.findIndex((entry) => entry.name !== keep);
    if (at < 0) break;
    const [removed] = entries.splice(at, 1);
    total -= removed.size;
    await unlink(path.join(dir, removed.name)).catch(() => {});
  }
}
async function saveIndex(dir, sha256, size, index) {
  if (!dir) return;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});
    const text = JSON.stringify({ ...index, sha256, size });
    if (Buffer.byteLength(text) > MAX_INDEX_FILE_BYTES) return;
    const temp = path.join(dir, `.${randomBytes(16).toString("hex")}.part`);
    let handle;
    try { handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch { return; }
    try { await handle.writeFile(text, "utf8"); } finally { await handle.close().catch(() => {}); }
    await rename(temp, path.join(dir, indexName(sha256)));
    await evictIndexes(dir, indexName(sha256));
  } catch { /* a derived cache that cannot be written never fails the read */ }
}
async function ensureIndex({ dir, digest, size, full, file, stat, kind, extension }) {
  const cached = await loadIndex(dir, digest, size);
  if (cached) return cached;
  const extracted = await extractText({ full, file, stat, kind, extension });
  const text = extracted.text.slice(0, MAX_TEXT_CHARS);
  let index;
  try { index = buildIndex(text, extracted.pageStarts); } catch { fail("index_failed"); }
  const stored = { ...index, format: extracted.format };
  await saveIndex(dir, digest, size, stored);
  return stored;
}

// Cuts one window without splitting a surrogate pair. Offsets and lengths are UTF-16 code units.
export function windowText(text, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length || (offset === text.length && text.length > 0)) fail("invalid_offset");
  let end = Math.min(text.length, offset + MAX_WINDOW_CHARS);
  if (end < text.length) { const last = text.charCodeAt(end - 1); if (last >= 0xd800 && last <= 0xdbff) end -= 1; }
  return { text: text.slice(offset, end), offset, nextOffset: end < text.length ? end : null, totalChars: text.length };
}

export async function readDocument({ home, name, offset = 0, layout, cacheDir }) {
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
    const dir = indexDirFor(home, cacheDir);
    const digest = await digestFile(file, stat.size);
    const index = await ensureIndex({ dir, digest, size: stat.size, full: path.join(places.inbox.dir, name), file, stat, kind, extension });
    let text = index.text;
    let truncated = index.truncated === true;
    if (text.length > MAX_TEXT_CHARS) { text = text.slice(0, MAX_TEXT_CHARS); truncated = true; }
    if (text.length === 0) fail("document_unreadable");
    return { kind: "text", format: index.format, truncated, ...windowText(text, offset) };
  } finally { await file.close().catch(() => {}); }
}

// Builds (or refreshes) the index for one inbox file. Called by the file server in the background after an upload.
export async function indexDocument({ home, name, layout, cacheDir }) {
  const places = layout ?? areas(home);
  await checkDir(places.inbox);
  const { file, stat } = await openRegular(places.inbox.dir, name, MAX_DOCUMENT_BYTES);
  try {
    const { kind } = await kindOf(file, stat.size, name);
    if (kind === "image") return { name, indexed: false, totalChars: 0, truncated: false };
    const dir = indexDirFor(home, cacheDir);
    const digest = await digestFile(file, stat.size);
    const existing = await loadIndex(dir, digest, stat.size);
    if (existing) return { name, indexed: true, totalChars: existing.text.length, truncated: existing.truncated === true };
    const index = await ensureIndex({ dir, digest, size: stat.size, full: path.join(places.inbox.dir, name), file, stat, kind, extension: path.posix.extname(name).toLowerCase() });
    return { name, indexed: true, totalChars: index.text.length, truncated: index.truncated === true };
  } finally { await file.close().catch(() => {}); }
}

// Best-matching passages with the page, sheet or slide at each start. `no_match` is a normal answer, not a fault.
export async function searchDocument({ home, name, query, layout, cacheDir }) {
  const places = layout ?? areas(home);
  await checkDir(places.inbox);
  const asked = typeof query === "string" ? query.trim().slice(0, 200) : "";
  if (!asked) fail("no_match");
  const { file, stat } = await openRegular(places.inbox.dir, name, MAX_DOCUMENT_BYTES);
  try {
    const { kind } = await kindOf(file, stat.size, name);
    if (kind === "image") fail("unsupported_type");
    const dir = indexDirFor(home, cacheDir);
    const digest = await digestFile(file, stat.size);
    const index = await ensureIndex({ dir, digest, size: stat.size, full: path.join(places.inbox.dir, name), file, stat, kind, extension: path.posix.extname(name).toLowerCase() });
    let results;
    try { results = searchIndex(index, asked, 5); } catch { fail("index_failed"); }
    if (!results.length) fail("no_match");
    return { format: index.format, totalChars: index.text.length, results };
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
  "invalid_offset", "deliver_failed", "scan_failed", "empty_file", "no_match", "index_failed"]);
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
    else if (mode === "index") result = await indexDocument({ home, name: params.name });
    else if (mode === "search") result = await searchDocument({ home, name: params.name, query: params.query });
    else fail("scan_failed");
    await out(`${JSON.stringify({ result })}\n`);
  } catch (error) {
    try { await out(`${JSON.stringify({ error: SAFE.has(error?.code) ? error.code : "scan_failed" })}\n`); } catch { /* reader gone */ }
    process.exitCode = 3;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
