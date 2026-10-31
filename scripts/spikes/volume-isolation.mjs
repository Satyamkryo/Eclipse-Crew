import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

export const BASE_IMAGE = "ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852";
const RUN_LABEL = "ai.eclipse.task009.run";
const COMPOSE = path.resolve("docker/spikes/task009.compose.yml");
const RUN_MS = 300000;
class SpikeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const requireCheck = (value, code) => { if (!value) throw new SpikeError(code); };
export function minimalEnvironment(source = process.env) {
  const env = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "PATH", "Path", "COMSPEC", "PATHEXT", "USERPROFILE", "HOME", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP",
    "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "SystemDrive", "HOMEDRIVE", "HOMEPATH"])
    if (source[key]) env[key] = source[key];
  return env;
}
export function resources(run) {
  requireCheck(/^[a-f0-9]{24}$/.test(run), "invalid_run");
  const project = `eclipse009${run}`;
  return { run, project, image: `${project}-fixture:spike`, volume: `${project}_homes`, container: `${project}-probe-1` };
}
export function validateVolume(value, names) {
  requireCheck(value?.Name === names.volume && value.Driver === "local" && !Object.keys(value.Options ?? {}).length &&
    value.Labels?.[RUN_LABEL] === names.run && value.Labels?.["com.docker.compose.project"] === names.project &&
    value.Labels?.["com.docker.compose.volume"] === "homes", "unsafe_volume");
}
export function validateImage(value, names) {
  requireCheck(value?.RepoTags?.includes(names.image) && value.Config?.Labels?.[RUN_LABEL] === names.run &&
    value.Config?.User === "20001:20001", "unsafe_image");
}
export function validateContainer(value, names, imageId) {
  const host = value?.HostConfig; const mounts = value?.Mounts;
  requireCheck(value?.Name === `/${names.container}` && value.Image === imageId &&
    value.Config?.Labels?.[RUN_LABEL] === names.run && value.Config.Labels["com.docker.compose.project"] === names.project &&
    value.Config.Labels["com.docker.compose.service"] === "probe" && value.Config.User === "20001:20001" &&
    host?.ReadonlyRootfs === true && host.NetworkMode === "none" && !host.Privileged &&
    JSON.stringify(host.CapDrop) === '["ALL"]' && !(host.CapAdd?.length) &&
    host.SecurityOpt?.includes("no-new-privileges:true") && !Object.keys(host.PortBindings ?? {}).length &&
    !(host.Devices?.length) && !(host.DeviceRequests?.length) &&
    Array.isArray(mounts) && mounts.length === 1 && mounts[0].Type === "volume" && mounts[0].Name === names.volume &&
    mounts[0].Destination === "/home" && mounts[0].RW === true &&
    (!host.Binds?.length || JSON.stringify(host.Binds) === JSON.stringify([`${names.volume}:/home:rw`])) &&
    Object.keys(value.NetworkSettings?.Ports ?? {}).length === 0 &&
    Object.keys(value.NetworkSettings?.Networks ?? {}).every((key) => key === "none") &&
    (value.Config.Env ?? []).every((entry) => /^(PATH|HOME|LANG|LC_ALL)=/.test(entry)), "unsafe_container");
}
export function validateCompose(config, names) {
  const service = config?.services?.probe;
  requireCheck(Object.keys(config?.services ?? {}).length === 1 && service?.image === names.image &&
    service.user === "20001:20001" && service.read_only === true && service.network_mode === "none" &&
    service.cap_drop?.length === 1 && service.cap_drop[0] === "ALL" && !service.cap_add?.length &&
    service.security_opt?.includes("no-new-privileges:true") && !service.privileged &&
    !service.ports?.length && !service.secrets?.length && !service.env_file?.length &&
    !Object.keys(service.environment ?? {}).length && service.labels?.[RUN_LABEL] === names.run &&
    service.build?.network === "none" && service.build?.labels?.[RUN_LABEL] === names.run &&
    service.volumes?.length === 1 && service.volumes[0].type === "volume" &&
    service.volumes[0].source === "homes" && service.volumes[0].target === "/home" &&
    config.volumes?.homes?.name === names.volume && config.volumes.homes.driver === "local" &&
    !Object.keys(config.volumes.homes.driver_opts ?? {}).length &&
    config.volumes.homes.labels?.[RUN_LABEL] === names.run &&
    !Object.keys(config.networks ?? {}).length && !Object.keys(config.secrets ?? {}).length, "unsafe_compose");
}
export async function reserveEvidence(root) {
  const absolute = path.resolve(root); let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    await mkdir(current, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    const stat = await lstat(current);
    requireCheck(stat.isDirectory() && !stat.isSymbolicLink(), "unsafe_evidence");
  }
  const runId = randomUUID(); const directory = path.join(absolute, runId);
  await mkdir(directory, { mode: 0o700 }); return { runId, directory };
}
export async function runProcess(executable, args, { env, input, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; let length = 0; let timedOut = false; let oversized = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    const collect = (chunk) => {
      length += chunk.length;
      if (length > 1024 * 1024) { oversized = true; child.kill(); }
    };
    child.stdout.on("data", (chunk) => { collect(chunk); if (!oversized) output += chunk.toString("utf8"); });
    child.stderr.on("data", collect); // Never expose arbitrary Docker stderr or environment.
    child.once("error", () => { clearTimeout(timer); reject(new SpikeError("process_unavailable")); });
    child.once("close", (status) => { clearTimeout(timer); resolve({ status, output, timedOut, oversized }); });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
function parsed(text) { try { return JSON.parse(text); } catch { throw new SpikeError("invalid_docker_output"); } }
const safeCodes = new Set(["invalid_run", "unsafe_volume", "unsafe_image", "unsafe_container", "unsafe_compose", "unsafe_evidence",
  "process_unavailable", "timeout", "output_limit", "docker_failed", "linux_engine_required", "fixture_exists", "invalid_docker_output",
  "probe_failed", "benchmark_invalid", "existing_resources_changed", "cleanup_refused"]);

export async function runSpike({ dockerPath = "docker", evidenceRoot = path.resolve("data/spikes/task-009"), runner = runProcess } = {}) {
  const names = resources(randomBytes(12).toString("hex"));
  const evidence = await reserveEvidence(evidenceRoot); const started = performance.now();
  const summary = { task: "TASK-009", mode: runner === runProcess ? "docker" : "mock", runId: evidence.runId,
    utc: new Date().toISOString(), hostPlatform: process.platform, baseImage: BASE_IMAGE,
    stage: "preflight", outcome: "incomplete", checks: [], benchmarks: [], cleanup: "not_needed" };
  const env = { ...minimalEnvironment(), TASK009_RUN: names.run, TASK009_IMAGE: names.image };
  const emptyEnv = path.join(evidence.directory, "empty.env");
  await writeFile(emptyEnv, "", { flag: "wx", mode: 0o600 });
  const composeArgs = ["compose", "--env-file", emptyEnv, "--project-name", names.project, "--file", COMPOSE];
  let baseline; let created = false; let imageId;
  const invoke = async (args, { allowFailure = false, cleanup = false, timeout = 30000, input } = {}) => {
    const remaining = RUN_MS - (performance.now() - started);
    requireCheck(remaining > (cleanup ? 0 : 60000), "timeout");
    const value = await runner(dockerPath, args, { env, input,
      timeout: cleanup ? Math.min(20000, remaining) : Math.min(timeout, remaining - 60000) });
    requireCheck(!value.timedOut, "timeout"); requireCheck(!value.oversized, "output_limit");
    if (!allowFailure) requireCheck(value.status === 0, "docker_failed");
    return value;
  };
  const docker = async (args, options) => (await invoke(args, options)).output.trim();
  const compose = (args, options) => docker([...composeArgs, ...args], options);
  const snapshot = async (cleanup = false) => ({
    containers: (await docker(["ps", "-a", "--no-trunc", "--format", '{{.ID}} {{.Image}}'], { cleanup })).split(/\r?\n/).filter(Boolean).sort(),
    volumes: (await docker(["volume", "ls", "--format", '{{.Name}} {{.Driver}}'], { cleanup })).split(/\r?\n/).filter(Boolean).sort(),
  });
  const inspect = async (kind, name, cleanup = false) => {
    const value = await invoke([...(kind === "container" ? [] : [kind]), "inspect", name], { allowFailure: true, cleanup });
    if (value.status !== 0) {
      // Only an explicit empty inspect result counts as absent; connection/permission errors refuse cleanup.
      requireCheck(value.status === 1 && parsed(value.output).length === 0, "cleanup_refused"); return null;
    }
    const array = parsed(value.output); requireCheck(Array.isArray(array) && array.length === 1, "invalid_docker_output");
    return array[0];
  };
  try {
    const engine = parsed(await docker(["version", "--format", '{{json .Server}}']));
    requireCheck(engine.Os === "linux", "linux_engine_required");
    summary.engine = { os: engine.Os, version: engine.Version, architecture: engine.Arch };
    baseline = await snapshot();
    for (const [kind, name] of [["container", names.container], ["volume", names.volume], ["image", names.image]])
      requireCheck(await inspect(kind, name) === null, "fixture_exists");
    const config = parsed(await compose(["config", "--format", "json"])); validateCompose(config, names);
    const dockerfile = (await readFile("docker/spikes/task009.Dockerfile", "utf8")).replace(/\r\n/g, "\n");
    requireCheck(dockerfile.startsWith(`FROM ${BASE_IMAGE}\n`), "unsafe_image");
    const script = (await readFile("scripts/spikes/volume-isolation-check.sh", "utf8")).replace(/\r\n/g, "\n");
    summary.stage = "build"; created = true;
    await compose(["build", "probe"], { timeout: 120000 });
    const built = await inspect("image", names.image); validateImage(built, names); imageId = built.Id;
    summary.fixtureImageId = imageId;
    summary.stage = "start";
    await compose(["up", "-d", "--no-build", "probe"]);
    const ps = parsed(await compose(["ps", "--format", "json"]));
    requireCheck(ps.Service === "probe" && ps.State === "running", "probe_failed");
    validateContainer(await inspect("container", names.container), names, imageId);
    validateVolume(await inspect("volume", names.volume), names);
    const check = async (mode, agent, round) => {
      const user = agent === "agent_a" ? "20001:20001" : "20002:20002";
      const peer = agent === "agent_a" ? "agent_b" : "agent_a";
      const begin = performance.now();
      const args = ["exec", "--interactive", "--user", user, "--workdir", `/home/${agent}`, names.container,
        "timeout", "--kill-after=2s", "60s", "bash", "-s", "--", mode, agent, peer, names.run, ...(round ? [String(round)] : [])];
      const result = parsed(await docker(args, { input: script, timeout: 65000 }));
      requireCheck(result.agent === agent && result.phase === mode, "probe_failed");
      if (mode === "bench") {
        requireCheck(result.round === round && result.files === 1000 && result.fileBytes === 4096 && result.sequentialBytes === 33554432 &&
          result.checksumVerified === true && ["createNs", "readNs", "renameNs", "deleteNs", "writeNs", "sequentialReadNs"].every((key) =>
            Number.isSafeInteger(result[key]) && result[key] > 0 && result[key] < 60e9), "benchmark_invalid");
        summary.benchmarks.push({ agent, round, files: 1000, fileBytes: 4096, sequentialBytes: 33554432,
          timing: "Linux date +%s%N elapsed; cached reads; write includes fdatasync; checksum verified",
          ...Object.fromEntries(["createNs", "readNs", "renameNs", "deleteNs", "writeNs", "sequentialReadNs"].map((key) => [key, result[key]])),
          sequentialWriteMiBps: +(32e9 / result.writeNs).toFixed(2), sequentialReadMiBps: +(32e9 / result.sequentialReadNs).toFixed(2),
          hostCommandMs: Math.round(performance.now() - begin) });
      } else {
        requireCheck(result.passed === true && (mode !== "deny" || result.checks === 10), "probe_failed");
        summary.checks.push({ stage: summary.stage, phase: mode, agent, passed: true, ...(mode === "deny" ? { deniedChecks: 10 } : {}) });
      }
    };
    summary.stage = "permissions";
    for (const agent of ["agent_a", "agent_b"]) await check("init", agent);
    for (const agent of ["agent_a", "agent_b"]) await check("deny", agent);
    for (const agent of ["agent_a", "agent_b"]) await check("verify", agent);
    summary.stage = "persistence";
    const original = (await inspect("container", names.container)).Id;
    await compose(["up", "-d", "--no-build", "--force-recreate", "probe"]);
    const recreated = await inspect("container", names.container); validateContainer(recreated, names, imageId);
    requireCheck(recreated.Id !== original, "probe_failed"); validateVolume(await inspect("volume", names.volume), names);
    for (const mode of ["verify", "deny", "verify"]) for (const agent of ["agent_a", "agent_b"]) await check(mode, agent);
    summary.stage = "performance";
    for (const agent of ["agent_a", "agent_b"]) for (let round = 1; round <= 3; round++) await check("bench", agent, round);
    for (const agent of ["agent_a", "agent_b"]) await check("verify", agent);
    summary.outcome = "passed"; summary.stage = "complete";
  } catch (error) {
    summary.outcome = "incomplete"; summary.reason = safeCodes.has(error?.code) ? error.code : "unexpected_failure";
  } finally {
    if (created) {
      summary.cleanup = "refused";
      try {
        const container = await inspect("container", names.container, true);
        const volume = await inspect("volume", names.volume, true);
        const image = await inspect("image", names.image, true);
        if (image) validateImage(image, names);
        if (container) validateContainer(container, names, imageId ?? image?.Id);
        if (volume) validateVolume(volume, names);
        // Validate everything first; do not delete partially when any identity is suspect.
        if (container) await docker(["rm", "--force", container.Id], { cleanup: true });
        if (volume) await docker(["volume", "rm", names.volume], { cleanup: true });
        if (image) await docker(["image", "rm", names.image], { cleanup: true });
        for (const [kind, name] of [["container", names.container], ["volume", names.volume], ["image", names.image]])
          requireCheck(await inspect(kind, name, true) === null, "cleanup_refused");
        summary.cleanup = "complete";
      } catch {
        summary.outcome = "incomplete"; summary.cleanup = "refused";
        summary.remainingResources = { container: names.container, volume: names.volume, image: names.image };
      }
    }
    if (baseline) {
      try {
        const after = await snapshot(true);
        requireCheck(baseline.containers.every((value) => after.containers.includes(value)) && baseline.volumes.every((value) => after.volumes.includes(value)), "existing_resources_changed");
        summary.existingResourcesUnchanged = true;
      } catch { summary.existingResourcesUnchanged = false; summary.outcome = "incomplete"; summary.reason = "existing_resources_changed"; }
    }
    summary.durationMs = Math.round(performance.now() - started);
    await writeFile(path.join(evidence.directory, "result.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  return { summary, evidence: `data/spikes/task-009/${evidence.runId}/result.json` };
}

async function main() {
  try {
    if (process.argv.length !== 2) {
      if (process.argv.length === 3 && process.argv[2] === "--help") {
        console.log("Usage: npm run spike:volume-isolation — disposable Docker TASK-009 fixture; no model calls."); return;
      }
      throw new SpikeError("invalid_arguments");
    }
    let dockerPath = "docker";
    if (process.platform === "win32") {
      const installed = "E:\\Apps\\Docker\\resources\\bin\\docker.exe";
      try { await access(installed); dockerPath = installed; } catch { /* Use PATH on other installations. */ }
    }
    const result = await runSpike({ dockerPath });
    console.log(JSON.stringify(result)); if (result.summary.outcome !== "passed") process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ outcome: "incomplete", reason: safeCodes.has(error?.code) ? error.code : "preflight_failed" })); process.exitCode = 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
