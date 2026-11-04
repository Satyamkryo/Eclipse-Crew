#!/usr/bin/env node
// Resolve the desktop package closure for one CPU from GPG-verified Ubuntu metadata.
//
// The resolver runs `apt-get --print-uris` inside the pinned Ubuntu 24.04 base image on a
// native host of the target architecture. apt verifies the signed InRelease files with the
// keyring already present in the base image; this script never installs a package. It then
// records the exact URLs, sizes and SHA-256 values that fetch-packages.mjs verifies at build.
//
// Usage (on an arm64 Oracle VM):
//   node scripts/resolve-package-lock.mjs --arch arm64
//   node scripts/resolve-package-lock.mjs --arch arm64 --output /tmp/reviewed.lock.json
//
// The amd64 lock is pinned; resolving amd64 requires an explicit --output review path.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const BASE_IMAGE = "ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852";
export const PACKAGE_LIST = new URL("../docker/desktop/packages.txt", import.meta.url);
export const ARCHITECTURES = {
  amd64: {
    hosts: ["archive.ubuntu.com", "security.ubuntu.com"],
    pathPrefix: "/ubuntu/",
    lock: "../docker/desktop/ubuntu-packages.lock.json",
    pinned: true,
  },
  arm64: {
    hosts: ["ports.ubuntu.com"],
    pathPrefix: "/ubuntu-ports/",
    lock: "../docker/desktop/ubuntu-packages.arm64.lock.json",
    pinned: false,
  },
};
const NAME = /^[a-z0-9][a-z0-9+.-]+$/;
const FILE = /^([a-z0-9][a-z0-9+.-]+)_([0-9][A-Za-z0-9.+:~\-]*)_([a-z0-9]+)\.deb$/;
const MAX_OUTPUT = 64 * 1024 * 1024;
const MAX_PACKAGES = 2048;

function fail(message) { throw Error(message); }

export function parsePackageList(text) {
  const roots = []; const seen = new Set();
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (line === "" || line.startsWith("#")) continue;
    if (!NAME.test(line)) fail("invalid_package_root");
    if (seen.has(line)) fail("duplicate_package_root");
    seen.add(line); roots.push(line);
  }
  if (!roots.length) fail("empty_package_roots");
  return roots;
}

function normalizeUrl(value, { hosts, pathPrefix }) {
  let url;
  try { url = new URL(value); } catch { fail("invalid_package_source"); }
  if (!["http:", "https:"].includes(url.protocol) || !hosts.includes(url.hostname) || url.port ||
      url.username || url.password || url.hash || url.search || /%2f|%5c/i.test(url.pathname) ||
      !new RegExp(`^${pathPrefix}pool/(main|universe|restricted|multiverse)/[a-z0-9+_.%\\-/]+\\.deb$`, "i").test(url.pathname) ||
      decodeURIComponent(url.pathname).split("/").some((part) => part === "." || part === "..")) fail("invalid_package_source");
  // The archive prints http URLs; the build downloads only over TLS. apt escapes '+',
  // while the reviewed amd64 lock keeps it literal; normalize to the same stable form.
  url.protocol = "https:";
  url.pathname = url.pathname.replace(/%2b/gi, "+");
  return url.toString();
}

// Ubuntu's apt prints only the legacy MD5 field from `--print-uris`; the exact SHA-256 is
// read from the same verified package metadata through `apt-cache show` and joined here.
export function parsePrintUris(text, { architecture, hosts, pathPrefix }) {
  if (!Object.hasOwn(ARCHITECTURES, architecture)) fail("unsupported_target_architecture");
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const entries = []; const names = new Set(); const filenames = new Set();
  for (const line of lines) {
    const match = /^'([^']{1,2048})' (\S{1,512}) (\d{1,12}) \S+$/.exec(line);
    if (!match) continue;
    const filename = match[2].replace(/%3a/gi, ":");
    if (filename.includes("%")) fail("unsupported_filename_encoding");
    const parsed = FILE.exec(filename);
    if (!parsed) fail("invalid_package_entry");
    const [, name, version, entryArch] = parsed;
    if (!["all", architecture].includes(entryArch)) fail("wrong_package_architecture");
    if (filename !== `${name}_${version}_${entryArch}.deb`) fail("invalid_package_entry");
    const bytes = +match[3];
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 64 * 1024 * 1024) fail("invalid_package_entry");
    if (names.has(name)) fail("duplicate_package");
    if (filenames.has(filename)) fail("duplicate_package");
    names.add(name); filenames.add(filename);
    entries.push({ name, version, architecture: entryArch, filename,
      url: normalizeUrl(match[1], { hosts, pathPrefix }), bytes, sha256: null });
    if (entries.length > MAX_PACKAGES) fail("too_many_packages");
  }
  if (!entries.length) fail("no_packages_resolved");
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function parseParagraphs(text) {
  const paragraphs = []; let current = null;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (line === "") { if (current) paragraphs.push(current); current = null; continue; }
    if (line.startsWith(" ")) continue;
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    if (!current) current = [];
    current.push([line.slice(0, colon), line.slice(colon + 1).trim()]);
  }
  if (current) paragraphs.push(current);
  return paragraphs.map((entries) => Object.fromEntries(entries));
}

export function applyAptCacheHashes(text, entries) {
  const byKey = new Map();
  for (const paragraph of parseParagraphs(text)) {
    const key = `${paragraph.Package}\0${paragraph.Version}\0${paragraph.Architecture}`;
    byKey.set(key, paragraph);
  }
  return entries.map((entry) => {
    const metadata = byKey.get(`${entry.name}\0${entry.version}\0${entry.architecture}`);
    if (!metadata) fail(`metadata_hash_missing_${entry.name}`);
    if (!/^[a-f0-9]{64}$/.test(metadata.SHA256 ?? "")) fail(`metadata_hash_missing_${entry.name}`);
    if (+metadata.Size !== entry.bytes) fail(`metadata_size_mismatch_${entry.name}`);
    if (path.posix.basename(metadata.Filename ?? "") !==
        path.posix.basename(decodeURIComponent(new URL(entry.url).pathname))) fail(`metadata_filename_mismatch_${entry.name}`);
    return { ...entry, sha256: metadata.SHA256 };
  });
}

export function buildManifest(architecture, entries, provenance) {
  if (!Object.hasOwn(ARCHITECTURES, architecture)) fail("unsupported_target_architecture");
  return { schema: 1, ubuntu: "24.04", architecture, provenance, packages: entries };
}

export function manifestBytes(manifest) {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function lockSummary(manifest, bytes) {
  return { architecture: manifest.architecture, count: manifest.packages.length,
    bytes: manifest.packages.reduce((sum, entry) => sum + entry.bytes, 0),
    sha256: createHash("sha256").update(bytes).digest("hex") };
}

function usage() {
  return "usage: resolve-package-lock.mjs --arch amd64|arm64 [--output <file>]";
}

function docker(args, timeout) {
  return spawnSync("docker", args, { encoding: "utf8", maxBuffer: MAX_OUTPUT, timeout, windowsHide: true });
}

// `docker info` reports the machine name (x86_64/aarch64); `docker version` reports the
// package name (amd64/arm64). Accept both spellings for the selected CPU only.
export const DAEMON_ARCHITECTURES = { amd64: ["amd64", "x86_64"], arm64: ["arm64", "aarch64"] };

export function requireNativeArchitecture(architecture, run = docker) {
  const result = run(["info", "--format", "{{.Architecture}}"], 30000);
  if (result.error || result.status !== 0) fail("docker_unavailable");
  if (!DAEMON_ARCHITECTURES[architecture].includes(result.stdout.trim())) fail("native_architecture_required");
}

function resolveWithApt(architecture, roots, run = docker) {
  const script = `export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null 2>&1 || exit 11; ` +
    `apt-get --print-uris --yes --no-install-recommends install ${roots.join(" ")} 2>/dev/null`;
  const result = run(["run", "--rm", "--platform", `linux/${architecture}`, BASE_IMAGE, "sh", "-c", script], 300000);
  if (result.error || result.status !== 0) fail("metadata_resolution_failed");
  return result.stdout;
}

// Every argument is a validated `name=version`; no shell interpolation from file contents.
function readAptCache(architecture, entries, run = docker) {
  const query = entries.map((entry) => `${entry.name}=${entry.version}`).join(" ");
  const script = `export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null 2>&1 || exit 11; ` +
    `apt-cache show ${query} 2>/dev/null`;
  const result = run(["run", "--rm", "--platform", `linux/${architecture}`, BASE_IMAGE, "sh", "-c", script], 300000);
  if (result.error || result.status !== 0) fail("metadata_hash_unavailable");
  return result.stdout;
}

async function main() {
  const args = process.argv.slice(2);
  let architecture; let output; let force = false;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === "--help") { console.log(usage()); return; }
    if (value === "--arch") architecture = args[++index];
    else if (value === "--output") output = args[++index];
    else if (value === "--force") force = true;
    else fail("invalid_argument");
  }
  if (!architecture || !Object.hasOwn(ARCHITECTURES, architecture)) fail("unsupported_target_architecture");
  const spec = ARCHITECTURES[architecture];
  const defaultOutput = fileURLToPath(new URL(spec.lock, import.meta.url));
  if (architecture === "amd64" && !output) fail("amd64_lock_is_pinned");
  output = output ? path.resolve(output) : defaultOutput;
  if (output === defaultOutput && !spec.pinned && !force) {
    // The reviewed arm64 lock is created by this command; overwriting it needs an explicit
    // acknowledgement so an accidental resolver run cannot silently replace reviewed pins.
    try { await readFile(output); fail("lock_exists_use_force"); } catch (error) {
      if (error.message === "lock_exists_use_force") throw error;
    }
  }
  requireNativeArchitecture(architecture);
  const roots = parsePackageList(await readFile(PACKAGE_LIST, "utf8"));
  const printUris = resolveWithApt(architecture, roots);
  const resolved = parsePrintUris(printUris, { architecture, ...spec });
  const entries = applyAptCacheHashes(readAptCache(architecture, resolved), resolved);
  const manifest = buildManifest(architecture, entries,
    `Resolved on native ${architecture} against GPG-verified official noble/noble-updates/noble-security archive metadata with apt-get --print-uris; no packages installed during planning.`);
  const bytes = manifestBytes(manifest);
  await writeFile(output, bytes, { mode: 0o644 });
  console.log(JSON.stringify({ outcome: "lock_resolved", output: path.relative(process.cwd(), output) || output,
    ...lockSummary(manifest, bytes) }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) {
    const message = error && typeof error.message === "string" ? error.message : "";
    console.error(JSON.stringify({ outcome: "lock_resolution_failed", reason: /^[a-z0-9_+.-]+$/.test(message) ? message : "unexpected_error" }));
    process.exitCode = 1;
  }
}
