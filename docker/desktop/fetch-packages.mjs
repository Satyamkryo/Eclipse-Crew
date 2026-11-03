import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// One reviewed lock per CPU. The amd64 values are the TASK-010 pins and must not move;
// the arm64 row is filled only from a native resolution (see scripts/resolve-package-lock.mjs).
export const TARGETS = {
  amd64: {
    lock: "ubuntu-packages.lock.json",
    sha256: "6d0b40721a4b04b2ebe8f4fd7db4109eded14f3de27d51c9594dc1f0c8bae7cd",
    count: 445,
    bytes: 250231110,
    hosts: ["archive.ubuntu.com", "security.ubuntu.com"],
    pathPrefix: "/ubuntu/",
  },
  arm64: {
    lock: "ubuntu-packages.arm64.lock.json",
    sha256: null,
    count: null,
    bytes: null,
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
export async function fetchPackage(entry, directory, { fetchImpl = fetch, signal, target = "amd64" } = {}) {
  validateEntry(entry, target);
  const destination = path.join(directory, `${entry.sha256}.deb`); const partial = `${destination}.partial`;
  let file; let created = false;
  try {
    const response = await fetchImpl(entry.url, { redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])]) });
    if (!response.ok || !response.body) throw Error("package_download_failed");
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
export async function fetchPackages(entries, directory, { fetchImpl = fetch, signal, target = "amd64", onProgress = () => {} } = {}) {
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
