import { constants } from "node:fs";
import { lstat, mkdir, open, readlink, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { areas } from "./file-tools.mjs";
import { isPlainName } from "./outbox-reader.mjs";
import { AREAS, MAX_DEPTH, MAX_RESTORABLE_BYTES, ToolError } from "./checkpoint-tools.mjs";

// TASK-043. Runs as the agent's own Linux user. Writes one checkpointed file back into the agent's areas, or moves a file
// that did not exist at that checkpoint into a hidden `.rewound/<bucket>/` folder. Nothing here deletes a file, follows a
// symlink, or reports a real path to the app: only fixed codes leave this process.
const fail = (code) => { throw new ToolError(code); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

async function areaDir(place) {
  if (place.alias) {
    let target; try { target = await readlink(place.alias); } catch { return fail("target_blocked"); }
    if (target !== place.dir) fail("target_blocked");
  }
  let stat; try { stat = await lstat(place.dir); } catch (error) { if (error?.code === "ENOENT") return null; return fail("scan_failed"); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) fail("target_blocked");
  return place.dir;
}

function segmentsOf(rel) {
  if (typeof rel !== "string") fail("path_invalid");
  const segments = rel.split("/");
  if (segments.length < 1 || segments.length > MAX_DEPTH || !segments.every(isPlainName)) fail("path_invalid");
  return segments;
}

async function ensureDirectory(parent, name) {
  const next = path.join(parent, name);
  let stat; try { stat = await lstat(next); } catch (error) {
    if (error?.code !== "ENOENT") fail("path_invalid");
    try { await mkdir(next, { mode: 0o700 }); } catch { fail("target_blocked"); }
    stat = await lstat(next);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) fail("target_blocked");
  return next;
}

async function targetDirectory(place, segments) {
  let current = place;
  for (const segment of segments) current = await ensureDirectory(current, segment);
  return current;
}

async function* chunksOf(read) {
  if (read == null) return;
  if (Buffer.isBuffer(read) || read instanceof Uint8Array) { yield Buffer.from(read); return; }
  for await (const chunk of read) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

// Atomic replace: a hidden temp file in the same directory, then rename. The renaming file is never a symlink because it
// is created with O_EXCL | O_NOFOLLOW. On Windows (tests only; production is the Linux desktop) rename cannot replace an
// existing file, so remove the verified regular target first.
async function replace(temp, target) {
  try { await rename(temp, target); return; } catch (error) {
    if (process.platform !== "win32" || !["EEXIST", "EPERM", "EACCES"].includes(error?.code)) throw error;
  }
  let stat; try { stat = await lstat(target); } catch { throw Object.assign(new Error("rename_failed"), { code: "target_blocked" }); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("target_blocked");
  await rm(target);
  await rename(temp, target);
}

export async function putFile({ home, layout, area, rel, sha256, size, read }) {
  if (!AREAS.includes(area) || !HASH.test(sha256 ?? "") || !Number.isSafeInteger(size) || size < 0 || size > MAX_RESTORABLE_BYTES) fail("path_invalid");
  const segments = segmentsOf(rel);
  const places = layout ?? areas(home);
  const place = await areaDir(places[area]);
  if (!place) fail("target_blocked");
  const parent = await targetDirectory(place, segments.slice(0, -1));
  const target = path.join(parent, segments[segments.length - 1]);
  let existing; try { existing = await lstat(target); } catch (error) { if (error?.code !== "ENOENT") fail("target_blocked"); }
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) fail("target_blocked");

  const temp = path.join(parent, `.restore-${randomUUID()}.part`);
  const hash = createHash("sha256");
  let count = 0;
  let file;
  try {
    file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    for await (const chunk of chunksOf(read)) {
      count += chunk.length;
      if (count > size || count > MAX_RESTORABLE_BYTES) fail("content_changed");
      hash.update(chunk);
      await file.write(chunk);
    }
    await file.sync();
    await file.close(); file = undefined;
    if (count !== size || hash.digest("hex") !== sha256) fail("content_changed");
    await replace(temp, target);
    return { size: count, sha256 };
  } catch (error) {
    if (file) await file.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
    if (error?.code && typeof error.code === "string") throw error;
    fail("scan_failed");
  }
}

export async function asideFile({ home, layout, area, rel, bucket }) {
  if (!AREAS.includes(area) || !UUID.test(bucket ?? "")) fail("path_invalid");
  const segments = segmentsOf(rel);
  const places = layout ?? areas(home);
  const place = await areaDir(places[area]);
  if (!place) fail("file_not_found");
  let parent = place;
  for (const segment of segments.slice(0, -1)) {
    parent = path.join(parent, segment);
    let stat; try { stat = await lstat(parent); } catch { return fail("file_not_found"); }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) fail("file_not_found");
  }
  const source = path.join(parent, segments[segments.length - 1]);
  let stat; try { stat = await lstat(source); } catch { return fail("file_not_found"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("file_not_found");

  const bucketDir = await targetDirectory(place, [".rewound", bucket]);
  const destinationDir = await targetDirectory(bucketDir, segments.slice(0, -1));
  const destination = path.join(destinationDir, segments[segments.length - 1]);
  try { await lstat(destination); fail("target_blocked"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  await rename(source, destination);
  return { moved: true };
}

// ---- command line ----------------------------------------------------------------------------------------------

const SAFE = new Set(["file_not_found", "file_too_large", "content_changed", "too_many_files", "scan_limit", "scan_failed",
  "path_invalid", "target_blocked"]);
async function main() {
  const out = (value) => new Promise((resolve, reject) => process.stdout.write(value, (error) => error ? reject(error) : resolve()));
  try {
    const mode = process.argv[2]; const params = JSON.parse(process.argv[3] ?? "");
    const home = process.env.HOME ?? "";
    if (!/^\/workspace\/homes\/[0-9a-f-]{36}$/.test(home) || !params || typeof params !== "object") fail("scan_failed");
    let result;
    if (mode === "put") result = await putFile({ home, area: params.area, rel: params.path, sha256: params.sha256, size: params.size, read: process.stdin });
    else if (mode === "aside") result = await asideFile({ home, area: params.area, rel: params.path, bucket: params.bucket });
    else fail("scan_failed");
    await out(`${JSON.stringify({ result })}\n`);
  } catch (error) {
    try { await out(`${JSON.stringify({ error: SAFE.has(error?.code) ? error.code : "scan_failed" })}\n`); } catch { /* reader gone */ }
    process.exitCode = 3;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
