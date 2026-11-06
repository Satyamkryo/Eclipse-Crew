import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { get } from "node:https";
import { Readable } from "node:stream";

// One reviewed lock per CPU. The amd64 values are the TASK-010 pins; Ubuntu removes superseded security versions, so a
// removed pin moves only to the version in the signed index (2026-11-06: libsoup3 to 3.4.4-5ubuntu0.10).
// ARM packages were resolved natively on Oracle from signed Ubuntu archive metadata.
export const TARGETS = {
  amd64: {
    lock: "ubuntu-packages.lock.json",
    sha256: "d25e17b80194edf7e7133515d70daad6da2ab9a91c3f6d10a19fd716af40435a",
    count: 445,
    bytes: 250233152,
    hosts: ["archive.ubuntu.com", "security.ubuntu.com"],
    pathPrefix: "/ubuntu/",
  },
  arm64: {
    lock: "ubuntu-packages.arm64.lock.json",
    sha256: "acc7f512e07138ff80fb3fb68be4021e7002ed5f1f9b8494014889d6593bc0e2",
    count: 442,
    bytes: 242101668,
    hosts: ["ports.ubuntu.com"],
    pathPrefix: "/ubuntu-ports/",
  },
};
export const MANIFEST_SHA256 = TARGETS.amd64.sha256;

export function requireTarget(target) {
  if (typeof target !== "string" || !Object.hasOwn(TARGETS, target)) throw Error("unsupported_target_architecture");
  return TARGETS[target];
}

export function validateEntry(entry, target = "amd64") {
  const spec = requireTarget(target);
  if (!entry || Object.keys(entry).sort().join(",") !== "architecture,bytes,filename,name,sha256,url,version" ||
      !/^[a-z0-9][a-z0-9+.-]+$/.test(entry.name) || !/^[0-9][a-zA-Z0-9.+:~\-]*$/.test(entry.version) ||
      !["all", target].includes(entry.architecture) || entry.filename !== `${entry.name}_${entry.version}_${entry.architecture}.deb` ||
      !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes > 64 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw Error("invalid_package_entry");
  let url;
  try { url = new URL(entry.url); } catch { throw Error("invalid_package_source"); }
  if (url.protocol !== "https:" || !spec.hosts.includes(url.hostname) ||
      url.port || url.username || url.password || url.hash || url.search || /%2f|%5c/i.test(url.pathname) ||
      !new RegExp(`^${spec.pathPrefix}pool/(main|universe|restricted|multiverse)/[a-z0-9+_.%\\-/]+\\.deb$`, "i").test(url.pathname) ||
      decodeURIComponent(url.pathname).split("/").some((part) => part === "." || part === "..")) throw Error("invalid_package_source");
  return entry;
}
export function validateManifest(bytes, target = "amd64") {
  const spec = requireTarget(target);
  if (spec.sha256 === null) throw Error("package_lock_pending");
  if (bytes.length > 1024 * 1024) throw Error("invalid_package_manifest");
  const normalized = bytes.toString("utf8").replace(/\r\n/g, "\n");
  if (createHash("sha256").update(normalized).digest("hex") !== spec.sha256) throw Error("package_manifest_hash_mismatch");
  const manifest = JSON.parse(normalized);
  if (manifest.schema !== 1 || manifest.ubuntu !== "24.04" || manifest.architecture !== target || manifest.packages?.length !== spec.count)
    throw Error("invalid_package_manifest");
  for (const entry of manifest.packages) validateEntry(entry, target);
  if (new Set(manifest.packages.map((entry) => entry.filename)).size !== spec.count ||
      manifest.packages.reduce((sum, entry) => sum + entry.bytes, 0) !== spec.bytes) throw Error("invalid_package_manifest");
  return manifest;
}
// Stream through Node HTTPS instead of fetch: the pinned ARM build runtime can crash
// inside Undici's Parser.finish when an Ubuntu archive connection closes while paused.
// HTTPS verifies certificates normally and never follows redirects.
function packageRequest(url, { signal }) {
  return new Promise((resolve, reject) => {
    const request = get(url, { signal, agent: false }, (response) => {
      resolve({
        ok: response.statusCode >= 200 && response.statusCode < 300,
        headers: { get(name) {
          const value = response.headers[name.toLowerCase()];
          return Array.isArray(value) ? value.join(",") : value ?? null;
        } },
        body: Readable.toWeb(response),
      });
    });
    request.on("error", reject);
  });
}
export async function fetchPackage(entry, directory, { fetchImpl = packageRequest, signal, target = "amd64" } = {}) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { return await fetchPackageOnce(entry, directory, { fetchImpl, signal, target }); }
    catch (error) {
      // Ubuntu may close a reused connection during the large package closure download.
      // Restart the archive from scratch; integrity, HTTP and TLS failures never retry.
      const code = error?.cause?.code ?? error?.code;
      if (attempt >= 2 || !["UND_ERR_SOCKET", "ECONNRESET", "EPIPE"].includes(code) || signal?.aborted) throw error;
      await delay(250 * (attempt + 1), undefined, { signal });
    }
  }
}
async function fetchPackageOnce(entry, directory, { fetchImpl, signal, target }) {
  validateEntry(entry, target);
  const destination = path.join(directory, `${entry.sha256}.deb`); const partial = `${destination}.partial`;
  let file; let created = false;
  try {
    const response = await fetchImpl(entry.url, { redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])]) });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw Error("package_download_failed"); }
    const declared = response.headers.get("content-length");
    if (declared !== null && +declared !== entry.bytes) { await response.body.cancel(); throw Error("package_size_mismatch"); }
    file = await open(partial, "wx", 0o600); created = true;
    const hash = createHash("sha256"); let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length; if (bytes > entry.bytes) throw Error("package_size_mismatch"); hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const result = await file.write(chunk, offset, chunk.length - offset);
        if (result.bytesWritten <= 0) throw Error("package_write_failed"); offset += result.bytesWritten;
      }
    }
    if (bytes !== entry.bytes || hash.digest("hex") !== entry.sha256) throw Error("package_integrity_mismatch");
    await file.close(); file = undefined;
    await rename(partial, destination); created = false;
    return bytes;
  } finally {
    await file?.close().catch(() => {}); if (created) await rm(partial, { force: true });
  }
}
export async function fetchPackages(entries, directory, { fetchImpl = packageRequest, signal, target = "amd64", onProgress = () => {} } = {}) {
  for (const entry of entries) validateEntry(entry, target);
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let next = 0; let downloaded = 0; let completed = 0; let failure;
  const workers = Array.from({ length: 4 }, async () => {
    let entry;
    try {
      while (next < entries.length && !combined.aborted) {
        entry = entries[next++]; const bytes = await fetchPackage(entry, directory, { fetchImpl, signal: combined, target });
        downloaded += bytes; completed++;
        if (completed % 50 === 0 || completed === entries.length) onProgress(completed);
      }
    } catch (error) {
      if (!failure) { failure = error; failure.package = entry?.name; }
      controller.abort();
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
  if (completed !== entries.length) throw Error("package_fetch_aborted");
  return { packages: completed, bytes: downloaded };
}
async function main() {
  const target = process.env.TARGETARCH;
  const spec = requireTarget(target);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 300000);
  try {
    let locked;
    try { locked = await readFile(new URL(`./${spec.lock}`, import.meta.url)); } catch { throw Error("package_lock_missing"); }
    const manifest = validateManifest(locked, target);
    await mkdir("/debs", { mode: 0o700 });
    const result = await fetchPackages(manifest.packages, "/debs", { signal: controller.signal, target,
      onProgress: (verifiedPackages) => console.log(JSON.stringify({ verifiedPackages, totalPackages: spec.count })) });
    if (result.bytes !== spec.bytes) throw Error("locked_package_download_failed");
    console.log(JSON.stringify({ ...result, architecture: target, manifestSha256: spec.sha256 }));
  } finally { clearTimeout(timer); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) {
    const allowed = new Set(["invalid_package_entry", "invalid_package_source", "invalid_package_manifest", "package_manifest_hash_mismatch",
      "package_download_failed", "package_size_mismatch", "package_integrity_mismatch", "package_write_failed", "package_fetch_aborted",
      "locked_package_download_failed", "unsupported_target_architecture", "package_lock_missing", "package_lock_pending"]);
    console.error(JSON.stringify({ outcome: "locked_package_download_failed", reason: allowed.has(error.message) ? error.message : "transport_failed",
      ...(/^[a-z0-9][a-z0-9+.-]+$/.test(error.package ?? "") ? { package: error.package } : {}) })); process.exitCode = 1;
  }
}
