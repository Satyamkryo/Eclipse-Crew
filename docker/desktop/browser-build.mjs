import { createHash } from "node:crypto";
import { mkdir, open, rename, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// TASK-078. One CPU-independent install path and profile family, pinned per CPU in browser-build.lock.json.
export const BROWSER_ROOT = "/opt/chrome-for-testing";
export const BROWSER_EXECUTABLE = `${BROWSER_ROOT}/chrome-linux64/chrome`;
export const BROWSER_PROFILE = ".config/chrome-for-testing";
export const BROWSER_VERSION = "156.0.8078.80";

const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/;
// Both CPUs normalize to the existing /opt/chrome-for-testing/chrome-linux64 path so the
// executable, resources and per-agent profiles keep one contract.
export const BROWSER_TARGETS = {
  amd64: { channel: "linux64", archive: "chrome-linux64" },
  arm64: { channel: "linux-arm64", archive: "chrome-linux-arm64" },
};
export function requireBrowserTarget(target) {
  if (typeof target !== "string" || !Object.hasOwn(BROWSER_TARGETS, target)) throw Error("unsupported_target_architecture");
  return BROWSER_TARGETS[target];
}
export function validateBrowserEntry(entry, target = "amd64") {
  const spec = requireBrowserTarget(target);
  if (!entry || Object.keys(entry).sort().join(",") !== "bytes,sha256,url,version" ||
      typeof entry.version !== "string" || !VERSION.test(entry.version) ||
      !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes > 512 * 1024 * 1024 ||
      typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) throw Error("invalid_browser_entry");
  let url;
  try { url = new URL(entry.url); } catch { throw Error("invalid_browser_source"); }
  if (url.protocol !== "https:" || url.hostname !== "storage.googleapis.com" || url.port || url.username || url.password ||
      url.hash || url.search || !new RegExp(`^/chrome-for-testing-public/${entry.version.replaceAll(".", "\\.")}/${spec.channel}/${spec.archive}\\.zip$`).test(url.pathname))
    throw Error("invalid_browser_source");
  return entry;
}
export function validateBrowserLock(value) {
  if (!value || Object.keys(value).sort().join(",") !== "browsers,schema" || value.schema !== 1 ||
      !value.browsers || typeof value.browsers !== "object" || Object.keys(value.browsers).sort().join(",") !== "amd64,arm64")
    throw Error("invalid_browser_lock");
  // A missing ARM row fails closed; an archive is never inferred from the amd64 pin.
  const amd64 = validateBrowserEntry(value.browsers.amd64, "amd64");
  const arm64 = validateBrowserEntry(value.browsers.arm64, "arm64");
  if (amd64.version !== BROWSER_VERSION || arm64.version !== BROWSER_VERSION) throw Error("browser_version_mismatch");
  return value;
}
export async function loadBrowserLock(source = new URL("./browser-build.lock.json", import.meta.url)) {
  return validateBrowserLock(JSON.parse(await readFile(source, "utf8")));
}
export async function downloadBrowser(entry, destination, { fetchImpl = fetch, target = "amd64" } = {}) {
  validateBrowserEntry(entry, target);
  const partial = `${destination}.partial`;
  let file;
  try {
    const response = await fetchImpl(entry.url, { redirect: "error", signal: AbortSignal.timeout(600000) });
    if (!response.ok || !response.body) throw Error("browser_download_failed");
    const declared = response.headers.get("content-length");
    if (declared !== null && +declared !== entry.bytes) { await response.body.cancel(); throw Error("browser_size_mismatch"); }
    file = await open(partial, "wx", 0o644);
    const hash = createHash("sha256"); let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length; if (bytes > entry.bytes) throw Error("browser_size_mismatch"); hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const result = await file.write(chunk, offset, chunk.length - offset);
        if (result.bytesWritten <= 0) throw Error("browser_write_failed"); offset += result.bytesWritten;
      }
    }
    if (bytes !== entry.bytes || hash.digest("hex") !== entry.sha256) throw Error("browser_integrity_mismatch");
    await file.close(); file = undefined;
    await rename(partial, destination);
    return { bytes, version: entry.version };
  } finally {
    await file?.close().catch(() => {});
    if (file) await rm(partial, { force: true }).catch(() => {});
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, destination] = process.argv.slice(2);
    if (command !== "fetch" || !destination) throw Error("usage: browser-build.mjs fetch <destination>");
    // The Docker build supplies the target explicitly; the build-tool stage's own CPU is
    // irrelevant under cross-builds and is never used to choose an archive.
    const target = process.env.TARGETARCH;
    requireBrowserTarget(target);
    const lock = await loadBrowserLock();
    const entry = lock.browsers[target];
    await mkdir(path.dirname(destination), { recursive: true });
    JSON.parse(JSON.stringify(await downloadBrowser(entry, destination, { target })));
    console.log(JSON.stringify({ outcome: "browser_verified", architecture: target, version: entry.version, bytes: entry.bytes, sha256: entry.sha256 }));
  } catch (error) {
    console.error(JSON.stringify({ outcome: "browser_verify_failed", reason: /^[a-z_]{1,64}$/.test(error.message) ? error.message : "unexpected_error" }));
    process.exitCode = 1;
  }
}
