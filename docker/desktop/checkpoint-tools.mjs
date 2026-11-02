import { constants } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { areas } from "./file-tools.mjs";
import { isPlainName } from "./outbox-reader.mjs";

// TASK-032. Runs as the agent's own Linux user (like file-tools.mjs). Lists the files an agent owns, with their SHA-256, and
// returns the bytes of one of them. The app stores the bytes by hash; nothing here is trusted by the app without re-hashing.
// Everything it reads is untrusted data: plain names only, regular single-link files, no symlinks, no absolute paths in output.
export class ToolError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = (code) => { throw new ToolError(code); };

// 4 MiB so the base64 answer (about 5.6 MB) stays under the app's 6 MiB desktop response cap (same limit as images in TASK-067).
export const MAX_RESTORABLE_BYTES = 4 * 1024 ** 2;
export const MAX_FILES = 2000;
export const MAX_DEPTH = 6;
export const SCAN_MS = 5000;
export const AREAS = ["inbox", "work", "downloads", "outbox"];
const CHUNK = 1024 * 1024;

async function areaDir(place) {
  if (place.alias) {
    let target; try { target = await readlink(place.alias); } catch { return null; }
    if (target !== place.dir) fail("scan_failed");
  }
  let stat; try { stat = await lstat(place.dir); } catch (error) { if (error?.code === "ENOENT") return null; return fail("scan_failed"); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) fail("scan_failed");
  return place.dir;
}

async function hashFile(full, expected) {
  let file; try { file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return null; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.ino !== expected.ino || stat.dev !== expected.dev || stat.size !== expected.size || stat.size > MAX_RESTORABLE_BYTES) return null;
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(Math.min(CHUNK, Math.max(stat.size, 1)));
    for (let at = 0; at < stat.size;) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, stat.size - at), at);
      if (bytesRead === 0) return null;
      hash.update(buffer.subarray(0, bytesRead));
      at += bytesRead;
    }
    return hash.digest("hex");
  } finally { await file.close().catch(() => {}); }
}

// Every regular file in the four areas, sorted by area then path. Files above the restorable limit are listed by name and size
// only. Anything that is not a plain regular file (symlink, device, FIFO, hard-linked, hidden, oddly named) is skipped and counted.
export async function scanManifest({ home, layout, now = Date.now, limitMs = SCAN_MS, maxFiles = MAX_FILES }) {
  const places = layout ?? areas(home);
  const started = now();
  const entries = []; let skipped = 0;
  const walk = async (area, dir, rel, depth) => {
    if (now() - started > limitMs) fail("scan_limit");
    let names; try { names = (await readdir(dir)).sort(); } catch { return fail("scan_failed"); }
    for (const name of names) {
      if (!isPlainName(name)) { skipped += 1; continue; }
      const full = path.join(dir, name); const relative = rel ? `${rel}/${name}` : name;
      let stat; try { stat = await lstat(full); } catch { skipped += 1; continue; }
      if (stat.isSymbolicLink()) { skipped += 1; continue; }
      if (stat.isDirectory()) {
        if (typeof process.getuid === "function" && stat.uid !== process.getuid()) { skipped += 1; continue; }
        if (depth >= MAX_DEPTH) { skipped += 1; continue; }
        await walk(area, full, relative, depth + 1);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1) { skipped += 1; continue; }
      if (entries.length >= maxFiles) fail("too_many_files");
      if (stat.size > MAX_RESTORABLE_BYTES) { entries.push({ area, path: relative, size: stat.size, sha256: null, restorable: false }); continue; }
      const sha256 = await hashFile(full, stat);
      if (!sha256) { skipped += 1; continue; }
      entries.push({ area, path: relative, size: stat.size, sha256, restorable: true });
    }
  };
  for (const area of AREAS) {
    const dir = await areaDir(places[area]);
    if (dir) await walk(area, dir, "", 0);
  }
  return { entries, skipped };
}

// The bytes of one listed file, only if they still hash to `sha256`. Walks the path one directory at a time so no step can be a symlink.
export async function readBlob({ home, layout, area, rel, sha256 }) {
  if (!AREAS.includes(area) || typeof rel !== "string" || !/^[0-9a-f]{64}$/.test(sha256 ?? "")) fail("file_not_found");
  const segments = rel.split("/");
  if (segments.length < 1 || segments.length > MAX_DEPTH + 1 || !segments.every(isPlainName)) fail("file_not_found");
  const places = layout ?? areas(home);
  let current = await areaDir(places[area]);
  if (!current) fail("file_not_found");
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    let stat; try { stat = await lstat(current); } catch { return fail("file_not_found"); }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) fail("file_not_found");
  }
  const full = path.join(current, segments[segments.length - 1]);
  let before; try { before = await lstat(full); } catch { return fail("file_not_found"); }
  if (!before.isFile() || before.nlink !== 1) fail("file_not_found");
  if (before.size > MAX_RESTORABLE_BYTES) fail("file_too_large");
  let file; try { file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return fail("file_not_found"); }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size) fail("content_changed");
    const bytes = Buffer.alloc(stat.size);
    for (let at = 0; at < stat.size;) {
      const { bytesRead } = await file.read(bytes, at, Math.min(CHUNK, stat.size - at), at);
      if (bytesRead === 0) fail("content_changed");
      at += bytesRead;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) fail("content_changed");
    return { size: bytes.length, base64: bytes.toString("base64") };
  } finally { await file.close().catch(() => {}); }
}

// ---- command line ----------------------------------------------------------------------------------------------

const SAFE = new Set(["file_not_found", "file_too_large", "content_changed", "too_many_files", "scan_limit", "scan_failed"]);
async function main() {
  const out = (value) => new Promise((resolve, reject) => process.stdout.write(value, (error) => error ? reject(error) : resolve()));
  try {
    const mode = process.argv[2]; const params = JSON.parse(process.argv[3] ?? "");
    const home = process.env.HOME ?? "";
    if (!/^\/workspace\/homes\/[0-9a-f-]{36}$/.test(home) || !params || typeof params !== "object") fail("scan_failed");
    let result;
    if (mode === "manifest") result = await scanManifest({ home });
    else if (mode === "blob") result = await readBlob({ home, area: params.area, rel: params.path, sha256: params.sha256 });
    else fail("scan_failed");
    await out(`${JSON.stringify({ result })}\n`);
  } catch (error) {
    try { await out(`${JSON.stringify({ error: SAFE.has(error?.code) ? error.code : "scan_failed" })}\n`); } catch { /* reader gone */ }
    process.exitCode = 3;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
