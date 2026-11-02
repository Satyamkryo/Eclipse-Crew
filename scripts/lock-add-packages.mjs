#!/usr/bin/env node
// Resolve new Ubuntu packages from GPG-verified archive metadata and print exact lock entries.
// Read-only: writes only to a private temporary directory. Usage:
//   node scripts/lock-add-packages.mjs git
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ARCH = "amd64";
const COMPONENTS = ["main", "universe"];
// The desktop image starts from this pinned base, so its packages are already present.
const BASE_IMAGE = "ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852";
// Pinned Ubuntu keyring source; bump the pair together after reviewing the new archive key.
const KEYRING = { url: "https://archive.ubuntu.com/ubuntu/pool/main/u/ubuntu-keyring/ubuntu-keyring_2026.08.18.tar.xz",
  sha256: "652d6b53b7fd676e7d45e99076ebd44624d477f3883c1bcb7bcf6f2855cdf7c4" };
const SUITES = [
  { suite: "noble", base: "https://archive.ubuntu.com/ubuntu" },
  { suite: "noble-updates", base: "https://archive.ubuntu.com/ubuntu" },
  { suite: "noble-security", base: "https://security.ubuntu.com/ubuntu" },
];
const MAX_METADATA = 256 * 1024 * 1024;

function fail(message) { throw Error(message); }
function dependencyReason(term) {
  const safe = term.trim().replace(/[^a-z0-9+.-]+/gi, "_").replace(/_+/g, "_").toLowerCase().slice(0, 100);
  return `unsupported_dependency_${safe || "unknown"}`;
}
function run(command, args, input) {
  const result = spawnSync(command, args, { input, encoding: "buffer", maxBuffer: MAX_METADATA, timeout: 120000, windowsHide: true });
  if (result.error || result.status !== 0) fail(`tool_failed_${command}`);
  return result.stdout;
}
async function download(url, limit) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60000) });
  if (!response.ok || !response.body) fail("metadata_unavailable");
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length; if (bytes > limit) fail("metadata_too_large"); chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function cmpPart(a, b) {
  const order = (c) => c === "" ? 0 : /[0-9]/.test(c) ? 0 : /[A-Za-z]/.test(c) ? c.charCodeAt(0) : c === "~" ? -1 : c.charCodeAt(0) + 256;
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    const ai = i, bj = j;
    while (i < a.length && !/[0-9]/.test(a[i])) i++;
    while (j < b.length && !/[0-9]/.test(b[j])) j++;
    for (let x = ai, y = bj; x < i || y < j; x++, y++) {
      const oa = order(x < i ? a[x] : ""), ob = order(y < j ? b[y] : "");
      if (oa !== ob) return oa < ob ? -1 : 1;
    }
    const ni = i, nj = j;
    while (i < a.length && /[0-9]/.test(a[i])) i++;
    while (j < b.length && /[0-9]/.test(b[j])) j++;
    const da = a.slice(ni, i).replace(/^0+/, ""), db = b.slice(nj, j).replace(/^0+/, "");
    if (da.length !== db.length) return da.length < db.length ? -1 : 1;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}
export function compareVersions(a, b) {
  const split = (value) => { const colon = value.indexOf(":"); const epoch = colon < 0 ? 0 : +value.slice(0, colon);
    const rest = colon < 0 ? value : value.slice(colon + 1); const dash = rest.lastIndexOf("-");
    return { epoch, upstream: dash < 0 ? rest : rest.slice(0, dash), revision: dash < 0 ? "" : rest.slice(dash + 1) }; };
  const left = split(a), right = split(b);
  if (left.epoch !== right.epoch) return left.epoch < right.epoch ? -1 : 1;
  return cmpPart(left.upstream, right.upstream) || cmpPart(left.revision, right.revision);
}
function satisfies(version, op, target) {
  const result = compareVersions(version, target);
  return { ">=": result >= 0, ">": result > 0, "=": result === 0, "<=": result <= 0, "<": result < 0, "<<": result < 0, ">>": result > 0 }[op] === true;
}

function parseParagraphs(text) {
  const paragraphs = []; let current = null;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (line === "") { if (current) paragraphs.push(current); current = null; continue; }
    if (line.startsWith(" ")) { if (current) { const last = current.entries.at(-1); last[1] += `\n${line.slice(1)}`; } continue; }
    const colon = line.indexOf(":"); if (colon < 1) continue;
    if (!current) current = { entries: [] };
    current.entries.push([line.slice(0, colon), line.slice(colon + 1).trim()]);
  }
  if (current) paragraphs.push(current);
  return paragraphs.map((paragraph) => Object.fromEntries(paragraph.entries));
}

async function main() {
  const roots = process.argv.slice(2).filter((value) => /^[a-z0-9][a-z0-9+.-]+$/.test(value));
  if (!roots.length) fail("usage: lock-add-packages.mjs <package...>");
  const lock = JSON.parse(await readFile(new URL("../docker/desktop/ubuntu-packages.lock.json", import.meta.url)));
  const locked = new Map(lock.packages.map((entry) => [entry.name, entry]));
  const directory = await mkdtemp(path.join(tmpdir(), "eclipse-lock-"));
  try {
    const archive = await download(KEYRING.url, 8 * 1024 * 1024);
    if (createHash("sha256").update(archive).digest("hex") !== KEYRING.sha256) fail("keyring_hash_mismatch");
    const tarball = path.join(directory, "keyring.tar.xz"); await writeFile(tarball, archive, { mode: 0o600 });
    const keyring = path.join(directory, "ubuntu-archive-keyring.gpg");
    // GNU tar on Windows treats backslashes as escapes, so pass POSIX-style temporary paths.
    await writeFile(keyring, run("tar", ["--force-local", "-xJOf", tarball.replaceAll("\\", "/"), "ubuntu-keyring-2026.08.18/keyrings/ubuntu-archive-keyring.gpg"]), { mode: 0o600 });

    const baseQuery = spawnSync("docker", ["run", "--rm", BASE_IMAGE, "dpkg-query", "-W", "-f=${Package} ${Version}\n"],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 120000, windowsHide: true });
    if (baseQuery.error || baseQuery.status !== 0) fail("base_image_unavailable");
    const base = new Map(baseQuery.stdout.trim().split("\n").map((line) => {
      const [name, version] = line.trim().split(" "); return [name, { name, version }];
    }).filter(([name, entry]) => /^[a-z0-9][a-z0-9+.-]+$/.test(name) && entry.version));

    const index = new Map(); const provides = new Map();
    for (const { suite, base: urlBase } of SUITES) {
      const inRelease = await download(`${urlBase}/dists/${suite}/InRelease`, 8 * 1024 * 1024);
      const inReleasePath = path.join(directory, `${suite}.InRelease`); await writeFile(inReleasePath, inRelease, { mode: 0o600 });
      const verifiedPath = path.join(directory, `${suite}.cleartext`);
      run("gpgv", ["--output", verifiedPath.replaceAll("\\", "/"), "--keyring", keyring.replaceAll("\\", "/"), inReleasePath.replaceAll("\\", "/")]);
      const hashes = new Map();
      const text = await readFile(verifiedPath, "utf8"); let inSha = false;
      for (const line of text.split("\n")) {
        if (/^SHA256:/.test(line)) { inSha = true; continue; }
        if (inSha && /^\S/.test(line)) inSha = false;
        const match = inSha && /^ ([a-f0-9]{64}) +(\d+) +(\S+)$/.exec(line);
        if (match) hashes.set(match[3], { sha256: match[1], bytes: +match[2] });
      }
      for (const component of COMPONENTS) {
        const file = `${component}/binary-${ARCH}/Packages.xz`;
        const record = hashes.get(file); if (!record) continue;
        const url = `${urlBase}/dists/${suite}/${file}`;
        const compressed = await download(url, 64 * 1024 * 1024);
        if (compressed.length !== record.bytes || createHash("sha256").update(compressed).digest("hex") !== record.sha256) fail("packages_hash_mismatch");
        const packages = parseParagraphs(run("xz", ["-dc"], compressed).toString("utf8"));
        for (const item of packages) {
          if (!/^(amd64|all)$/.test(item.Architecture ?? "")) continue;
          const entry = { name: item.Package, version: item.Version, architecture: item.Architecture,
            filename: path.basename(item.Filename), url: `${urlBase}/${item.Filename.replace(/^\//, "")}`,
            bytes: +item.Size, sha256: item.SHA256, depends: item.Depends ?? "", preDepends: item.PreDepends ?? "", provides: item.Provides ?? "" };
          if (!/^[a-z0-9][a-z0-9+.-]+$/.test(entry.name ?? "") || !entry.filename.endsWith(".deb") || !Number.isSafeInteger(entry.bytes) || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) continue;
          const current = index.get(entry.name);
          if (!current || compareVersions(entry.version, current.version) > 0) index.set(entry.name, entry);
          for (const provided of entry.provides.split(",").map((value) => value.trim().split(" ")[0]).filter(Boolean)) {
            if (!provides.has(provided)) provides.set(provided, []); provides.get(provided).push(entry);
          }
        }
      }
    }

    const selected = new Map(); const queue = [...roots];
    const parseTerm = (term) => {
      const match = /^([a-z0-9][a-z0-9+.-]+)(?::[a-z0-9-]+)?(?: \((>=|>>|<=|<<|=|<|>) ([^)]+)\))?$/.exec(term.trim());
      return match ? { name: match[1], op: match[2], version: match[3] } : null;
    };
    const choose = (term) => {
      const parsed = parseTerm(term); if (!parsed) fail(dependencyReason(term));
      const present = locked.get(parsed.name) ?? base.get(parsed.name);
      if (present && (!parsed.op || satisfies(present.version, parsed.op, parsed.version))) return present;
      const providers = provides.get(parsed.name) ?? [];
      const installed = providers.find((candidate) => locked.has(candidate.name) || base.has(candidate.name));
      if (installed && !parsed.op) return locked.get(installed.name) ?? base.get(installed.name);
      const real = index.get(parsed.name);
      if (real && (!parsed.op || satisfies(real.version, parsed.op, parsed.version))) return real;
      for (const candidate of providers) if (!parsed.op) return candidate;
      fail(`dependency_unresolved_${parsed.name}`);
    };
    while (queue.length) {
      const name = queue.shift();
      if (selected.has(name)) continue;
      const present = locked.get(name) ?? base.get(name);
      if (present) { selected.set(name, present); continue; }
      const providers = provides.get(name) ?? [];
      const installed = providers.find((candidate) => locked.has(candidate.name) || base.has(candidate.name));
      const entry = installed ? locked.get(installed.name) ?? base.get(installed.name) : index.get(name) ?? providers[0];
      if (!entry) fail(`package_missing_${name}`);
      selected.set(name, entry); queue.push(...dependenciesOf(entry));
    }
    function dependenciesOf(entry) {
      return `${entry.preDepends ?? ""},${entry.depends ?? ""}`.split(",").map((value) => value.trim()).filter(Boolean)
        .map((term) => {
          let lastError;
          for (const part of term.split("|")) {
            try { return choose(part).name; } catch (error) { lastError = error; }
          }
          throw lastError ?? Error("dependency_unresolved");
        }).filter(Boolean);
    }

    const resolved = [...selected.values()].filter((entry) => !locked.has(entry.name) && !base.has(entry.name))
      .map(({ name, version, architecture, filename, url, bytes, sha256 }) => ({ name, version, architecture, filename, url, bytes, sha256 }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const totalBytes = lock.packages.reduce((sum, entry) => sum + entry.bytes, 0) + resolved.reduce((sum, entry) => sum + entry.bytes, 0);
    console.log(JSON.stringify({ roots, newPackages: resolved, newCount: resolved.length,
      lockCount: lock.packages.length + resolved.length, lockBytes: totalBytes }, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) {
    const message = error && typeof error.message === "string" ? error.message : "";
    console.error(JSON.stringify({ outcome: "lock_resolution_failed", reason: /^[a-z0-9_+.-]+$/.test(message) ? message : "unexpected_error" }));
    process.exitCode = 1;
  }
}
