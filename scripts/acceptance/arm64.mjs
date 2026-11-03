#!/usr/bin/env node
// TASK-066 native ARM64 acceptance preflight. Read-only: it never starts a privileged
// container, registers an emulator, publishes a port or prints environment/secrets.
//
// Run on the Oracle Ampere VM after `docker compose up -d`:
//   node scripts/acceptance/arm64.mjs --preflight [--image <tag>] [--save]
//   node scripts/acceptance/arm64.mjs --matrix --result build=pass --result start=pass ...
//
// A host that is not ARM64 is reported as refused; an emulated or cross-built result is
// never labelled native.
import { spawnSync } from "node:child_process";
import { mkdir, readFile, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_ARCHITECTURES = { amd64: ["x86_64", "amd64"], arm64: ["aarch64", "arm64"] };
export const MATRIX = [
  "lock_resolution", "native_build", "tool_inventory", "compose_healthy", "single_loopback_port",
  "seccomp_denials", "agent_users", "agent_isolation", "agent_sessions", "browser_sandbox",
  "browser_codecs", "browser_grounding", "app_argon2", "db_roles", "stream_takeover", "proof_export",
];
const STATUS = ["pass", "fail", "not_run"];

export function classify({ machine, daemonArch, imageArch, imageMarker }) {
  const reasons = [];
  if (!HOST_ARCHITECTURES.arm64.includes(machine)) reasons.push("host_not_arm64");
  if (!HOST_ARCHITECTURES.arm64.includes(daemonArch)) reasons.push("daemon_not_arm64");
  if (imageArch !== undefined && imageArch !== "arm64") reasons.push("image_not_arm64");
  if (imageMarker !== undefined && imageMarker !== "arm64") reasons.push("image_marker_not_arm64");
  return reasons.length ? { outcome: "refused", reasons } : { outcome: "native_arm64_ready", reasons: [] };
}

function command(file, args, timeout = 20000) {
  return spawnSync(file, args, { encoding: "utf8", timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
}

function value(file, args) {
  const result = command(file, args);
  return result.status === 0 ? `${result.stdout ?? ""}`.trim() : null;
}

async function osRelease() {
  try {
    const text = await readFile("/etc/os-release", "utf8");
    const match = /^PRETTY_NAME="?([^"\n]+)"?$/m.exec(text);
    return match ? match[1] : null;
  } catch { return null; }
}

async function memoryBytes() {
  try {
    const match = /^MemTotal:\s+(\d+) kB$/m.exec(await readFile("/proc/meminfo", "utf8"));
    return match ? +match[1] * 1024 : null;
  } catch { return null; }
}

async function diskBytes() {
  try { const stats = await statfs("/"); return stats.blocks * stats.bsize; } catch { return null; }
}

async function imageFacts(tag) {
  const architecture = value("docker", ["image", "inspect", "--format", "{{.Architecture}}", tag]);
  const marker = value("docker", ["run", "--rm", "--network", "none", "--entrypoint", "cat", tag, "/opt/eclipse/desktop/image-arch"]);
  return { architecture, marker };
}

async function preflight(image) {
  const machine = value("uname", ["-m"]);
  const daemonArch = value("docker", ["info", "--format", "{{.Architecture}}"]);
  const facts = image ? await imageFacts(image) : {};
  const report = {
    task: "TASK-066",
    mode: "native_arm64_preflight",
    outcome: null,
    reasons: [],
    host: { machine, kernel: value("uname", ["-r"]), os: await osRelease() },
    docker: {
      daemonArch,
      version: value("docker", ["version", "--format", "{{.Server.Version}}"]),
      compose: value("docker", ["compose", "version", "--short"]),
    },
    resources: { memoryBytes: await memoryBytes(), cpus: os.cpus().length, diskBytes: await diskBytes() },
    ...(image ? { image: { reference: image, architecture: facts.architecture, marker: facts.marker } } : {}),
  };
  Object.assign(report, classify({ machine, daemonArch, imageArch: facts.architecture, imageMarker: facts.marker }));
  // Informational only: presence of a binfmt handler is not proof either way, and this
  // script never registers or removes one.
  report.qemuBinfmtRegistered = value("sh", ["-c", "test -e /proc/sys/fs/binfmt_misc/qemu-aarch64 && echo yes || echo no"]) === "yes";
  return report;
}

export function matrix(results) {
  const statuses = Object.fromEntries(MATRIX.map((step) => [step, "not_run"]));
  for (const result of results) {
    const [step, status] = result.split("=");
    if (!Object.hasOwn(statuses, step)) throw Error(`unknown_matrix_step_${step}`);
    if (!STATUS.includes(status)) throw Error(`invalid_matrix_status_${status}`);
    statuses[step] = status;
  }
  return { task: "TASK-066", mode: "native_arm64_matrix", claimedNative: false, statuses };
}

async function save(report) {
  const directory = path.resolve("data/acceptance/task-066");
  await mkdir(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(directory, `${report.mode}-${stamp}.json`);
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return file;
}

async function main() {
  const args = process.argv.slice(2);
  let mode; let image; let persist = false; const results = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === "--help") { console.log("usage: arm64.mjs --preflight [--image <tag>] [--save] | --matrix --result <step>=<pass|fail|not_run>..."); return; }
    if (value === "--preflight") mode = "preflight";
    else if (value === "--matrix") mode = "matrix";
    else if (value === "--image") image = args[++index];
    else if (value === "--result") results.push(args[++index]);
    else if (value === "--save") persist = true;
    else throw Error("invalid_argument");
  }
  if (!mode) throw Error("usage_required");
  const report = mode === "preflight" ? await preflight(image) : matrix(results);
  if (persist) report.saved = path.relative(process.cwd(), await save(report));
  console.log(JSON.stringify(report));
  if (report.outcome === "refused") process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) {
    console.error(JSON.stringify({ outcome: "acceptance_refused", reason: /^[a-z0-9_+.-]+$/.test(error.message ?? "") ? error.message : "unexpected_error" }));
    process.exitCode = 1;
  }
}
