import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_SHA256 = "7f0a289be78f99081f38c289f5df1d290f175f95f251218c5f6fac465e607ff1";
export function validateEntry(entry) {
  if (!entry || Object.keys(entry).sort().join(",") !== "architecture,bytes,filename,name,sha256,url,version" ||
      !/^[a-z0-9][a-z0-9+.-]+$/.test(entry.name) || !/^[0-9][a-zA-Z0-9.+:~\-]*$/.test(entry.version) ||
      !["all", "amd64"].includes(entry.architecture) || entry.filename !== `${entry.name}_${entry.version}_${entry.architecture}.deb` ||
      !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes > 64 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw Error("invalid_package_entry");
  let url;
  try { url = new URL(entry.url); } catch { throw Error("invalid_package_source"); }
  if (url.protocol !== "https:" || !["archive.ubuntu.com", "security.ubuntu.com"].includes(url.hostname) ||
      url.port || url.username || url.password || url.hash || url.search || /%2f|%5c/i.test(url.pathname) ||
      !/^\/ubuntu\/pool\/(main|universe|restricted|multiverse)\/[a-z0-9+_.%/\-]+\.deb$/i.test(url.pathname) ||
      decodeURIComponent(url.pathname).split("/").some((part) => part === "." || part === "..")) throw Error("invalid_package_source");
  return entry;
}
export function validateManifest(bytes) {
  if (bytes.length > 1024 * 1024) throw Error("invalid_package_manifest");
  const normalized = bytes.toString("utf8").replace(/\r\n/g, "\n");
  if (createHash("sha256").update(normalized).digest("hex") !== MANIFEST_SHA256) throw Error("package_manifest_hash_mismatch");
  const manifest = JSON.parse(normalized);
  if (manifest.schema !== 1 || manifest.ubuntu !== "24.04" || manifest.architecture !== "amd64" || manifest.packages?.length !== 388)
    throw Error("invalid_package_manifest");
  for (const entry of manifest.packages) validateEntry(entry);
  if (new Set(manifest.packages.map((entry) => entry.filename)).size !== 388 ||
      manifest.packages.reduce((sum, entry) => sum + entry.bytes, 0) !== 232159408) throw Error("invalid_package_manifest");
  return manifest;
}
export async function fetchPackage(entry, directory, { fetchImpl = fetch, signal } = {}) {
  validateEntry(entry);
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
export async function fetchPackages(entries, directory, { fetchImpl = fetch, signal, onProgress = () => {} } = {}) {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let next = 0; let downloaded = 0; let completed = 0; let failure;
  const workers = Array.from({ length: 4 }, async () => {
    let entry;
    try {
      while (next < entries.length && !combined.aborted) {
        entry = entries[next++]; const bytes = await fetchPackage(entry, directory, { fetchImpl, signal: combined });
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
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 300000);
  try {
    const manifest = validateManifest(await readFile(new URL("./ubuntu-packages.lock.json", import.meta.url)));
    await mkdir("/debs", { mode: 0o700 });
    const result = await fetchPackages(manifest.packages, "/debs", { signal: controller.signal,
      onProgress: (verifiedPackages) => console.log(JSON.stringify({ verifiedPackages, totalPackages: 388 })) });
    if (result.bytes !== 232159408) throw Error("locked_package_download_failed");
    console.log(JSON.stringify({ ...result, manifestSha256: MANIFEST_SHA256 }));
  } finally { clearTimeout(timer); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) {
    const allowed = new Set(["invalid_package_entry", "invalid_package_source", "invalid_package_manifest", "package_manifest_hash_mismatch",
      "package_download_failed", "package_size_mismatch", "package_integrity_mismatch", "package_write_failed", "package_fetch_aborted", "locked_package_download_failed"]);
    console.error(JSON.stringify({ outcome: "locked_package_download_failed", reason: allowed.has(error.message) ? error.message : "transport_failed",
      ...(/^[a-z0-9][a-z0-9+.-]+$/.test(error.package ?? "") ? { package: error.package } : {}) })); process.exitCode = 1;
  }
}
