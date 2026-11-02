import { randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { minimalEnvironment, runProcess } from "./volume-isolation.mjs";

export const LABEL = "ai.eclipse.task071.run";
export const PROFILE_HASH = "fa1e603f170044c931a103bfbe3bac6cfc6c935bdc72408e01c4cf6425cde627";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CAPABILITIES = ["CHOWN", "DAC_OVERRIDE", "SETUID", "SETGID", "SETPCAP", "SYS_ADMIN"];
const requireSafe = (ok, code) => { if (!ok) throw new Error(code); };

export function resources(run) {
  requireSafe(/^[a-f0-9]{24}$/.test(run), "invalid_run");
  const prefix = `eclipse071${run}`;
  return { run, container: `${prefix}-probe`, network: `${prefix}-internal`, volume: `${prefix}-workspace`,
    image: `${prefix}-fixture:spike`, base: `${prefix}-base:spike` };
}

export function createArgs(names, profile) {
  resources(names.run);
  return ["create", "--name", names.container, "--label", `${LABEL}=${names.run}`, "--network", names.network,
    "--user", "0:0", "--read-only", "--cap-drop", "ALL", ...CAPABILITIES.flatMap((cap) => ["--cap-add", cap]),
    "--security-opt", "no-new-privileges:true", "--security-opt", `seccomp=${profile}`,
    "--shm-size", "128m", "--tmpfs", "/tmp:uid=65534,gid=65534,mode=1777,size=536870912",
    "--tmpfs", "/run:uid=0,gid=0,mode=755,size=16777216", "--mount", `type=volume,source=${names.volume},target=/workspace`, names.image];
}

export function validateContainer(value, names, imageId, expectedArmor = "docker-default") {
  const host = value?.HostConfig;
  const mounts = value?.Mounts;
  const caps = (host?.CapAdd ?? []).map((cap) => cap.replace(/^CAP_/, "")).sort();
  const security = host?.SecurityOpt ?? [];
  requireSafe(value?.Name === `/${names.container}` && value.Image === imageId &&
    value.Config?.Labels?.[LABEL] === names.run && value.Config.User === "0:0" &&
    JSON.stringify(value.Config.Entrypoint) === '["python3","/opt/eclipse/network-namespace.py"]' &&
    !(value.Config.Cmd?.length) && host?.ReadonlyRootfs && !host.Privileged && !host.Init &&
    JSON.stringify(host.CapDrop) === '["ALL"]' && JSON.stringify(caps) === JSON.stringify([...CAPABILITIES].sort()) &&
    security.includes("no-new-privileges:true") && security.some((item) => item.startsWith("seccomp=")) &&
    !security.some((item) => /unconfined/.test(item)) && value.AppArmorProfile === expectedArmor &&
    host.NetworkMode === names.network && !Object.keys(host.PortBindings ?? {}).length &&
    !(host.Devices?.length) && !(host.DeviceRequests?.length) && !(host.Binds?.length) &&
    !(host.VolumesFrom?.length) && !["host", "container"].some((mode) => host.PidMode?.startsWith(mode) || host.IpcMode?.startsWith(mode)) &&
    mounts?.length === 1 && mounts[0].Type === "volume" && mounts[0].Name === names.volume &&
    mounts[0].Destination === "/workspace" && mounts[0].RW === true &&
    Object.keys(value.NetworkSettings?.Networks ?? {}).join() === names.network &&
    Object.keys(host.Tmpfs ?? {}).sort().join() === "/run,/tmp" &&
    (value.Config.Env ?? []).every((entry) => /^(PATH|HOME|LANG|PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD)=/.test(entry)), "unsafe_container");
}

export function validateResource(kind, value, names, imageId) {
  const labels = value?.Labels ?? value?.Config?.Labels;
  requireSafe(labels?.[LABEL] === names.run, "cleanup_identity_refused");
  if (kind === "container") {
    requireSafe(value.Name === `/${names.container}` && value.Image === imageId, "cleanup_identity_refused");
  } else if (kind === "volume") {
    requireSafe(value.Name === names.volume && value.Driver === "local" && !Object.keys(value.Options ?? {}).length, "unsafe_volume");
  } else if (kind === "network") {
    requireSafe(value.Name === names.network && value.Internal === true && value.Driver === "bridge", "unsafe_network");
  } else if (kind === "image") {
    requireSafe(value.Id === imageId && value.RepoTags?.includes(names.image), "cleanup_identity_refused");
  } else throw new Error("invalid_resource_kind");
}

export function classify(report) {
  const checks = [...(report?.checks ?? []), ...(report?.agents ?? []).flatMap((agent) => agent.checks ?? [])];
  if (!Array.isArray(report?.agents) || report.agents.length !== 3 || !checks.length ||
      checks.some((item) => !["pass", "fail", "blocked"].includes(item.status))) return "incomplete";
  if (report.agents.some((agent) => agent.checks?.some((item) => item.name === "private_namespace_created" && item.status !== "pass"))) return "blocked";
  if (["supervisor_privilege_reduction", "distinct_and_recreated_namespaces", "sessions_reaped"]
    .some((name) => !report.checks?.some((item) => item.name === name))) return "incomplete";
  const required = ["agent_outer_privileges", "private_namespace_created", "private_localhost", "direct_tcp", "direct_dns_udp",
    "inherited_socket_boundary", "outer_network_namespace_requires_privilege", "no_outer_interface_or_route",
    "shared_loopback", "shared_ipv6_loopback", "controller_loopback",
    "direct_quic_udp", "direct_ipv6", "pathname_socket_boundary", "abstract_socket_boundary", "protected_socket_boundary",
    "bridge_allowed", "bridge_unlisted", "bridge_private", "bridge_metadata", "bridge_forbidden_dns", "bridge_redirect",
    "bridge_forged_identity", "chromium"];
  if (report.agents.some((agent) => required.some((name) => !agent.checks.some((item) => item.name === name)))) return "incomplete";
  return checks.some((item) => item.status === "fail") ? "failed" : checks.some((item) => item.status === "blocked") ? "blocked" : "passed";
}

export function finalize(outcome, cleanup, unchanged) {
  return cleanup !== "complete" || !unchanged ? "incomplete" : outcome;
}

async function safeDirectory(directory) {
  const absolute = path.resolve(directory);
  let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    await mkdir(cursor, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    const stat = await lstat(cursor);
    requireSafe(stat.isDirectory() && !stat.isSymbolicLink(), "unsafe_evidence_path");
  }
}

export async function runSpike({ runner = runProcess, evidenceRoot = path.join(ROOT, "test-results/network-namespace") } = {}) {
  const names = resources(randomBytes(12).toString("hex"));
  const directory = path.join(evidenceRoot, names.run);
  await safeDirectory(directory);
  const report = { task: "TASK-071", run: names.run, utc: new Date().toISOString(), mode: runner === runProcess ? "docker" : "mock",
    outcome: "incomplete", cleanup: "not_started", checks: [], resources: names };
  const started = Date.now();
  const env = minimalEnvironment(); // Never forward .env or service secrets.
  const invoke = async (args, { allowFailure = false, cleanup = false, timeout = 30000 } = {}) => {
    const remaining = (cleanup ? 300000 : 240000) - (Date.now() - started);
    requireSafe(remaining > 0, "spike_deadline");
    const result = await runner("docker", args, { env, timeout: Math.min(remaining, timeout) });
    requireSafe(!result.timedOut && !result.oversized, "docker_timeout_or_output_limit");
    requireSafe(allowFailure || result.status === 0, "docker_command_failed");
    return result;
  };
  const output = async (args, options) => (await invoke(args, options)).output.trim();
  const inspect = async (kind, name, cleanup = false) => {
    const result = await invoke([...(kind === "container" ? [] : [kind]), "inspect", name], { cleanup, allowFailure: true });
    const items = JSON.parse(result.output);
    if (result.status === 1 && Array.isArray(items) && items.length === 0) return null;
    requireSafe(result.status === 0 && items.length === 1, "inspect_refused");
    return items[0];
  };
  const snapshot = async (cleanup = false) => {
    const list = async (args) => (await output(args, { cleanup })).split(/\r?\n/).filter(Boolean).sort();
    const ids = await list(["ps", "-aq", "--no-trunc"]);
    const containers = ids.length ? await list(["inspect", "--format", "{{.Id}} {{.Image}} {{.State.Running}} {{.State.StartedAt}} {{.RestartCount}}", ...ids]) : [];
    return { containers, volumes: await list(["volume", "ls", "-q"]),
      networks: await list(["network", "ls", "--no-trunc", "-q"]) };
  };
  let baseId; let imageId; let baseline; let tagged = false;
  const created = new Set();
  try {
    const version = JSON.parse(await output(["version", "--format", "{{json .Server}}"]));
    requireSafe(version.Os === "linux" && version.Arch === "amd64", "linux_amd64_required");
    report.engine = { os: version.Os, arch: version.Arch, version: version.Version };
    const engineSecurity = JSON.parse(await output(["info", "--format", "{{json .SecurityOptions}}"]));
    const appArmorAvailable = engineSecurity.some((item) => /^name=apparmor(?:,|$)/.test(item));
    report.engine.appArmorAvailable = appArmorAvailable;
    report.checks.push({ name: "apparmor_available", status: appArmorAvailable ? "pass" : "blocked",
      reason: appArmorAvailable ? "docker_default_required" : "engine_has_no_apparmor_no_override_applied" });
    baseline = await snapshot();
    baseId = await output(["image", "inspect", "main-desktop", "--format", "{{.Id}}"]);
    requireSafe(/^sha256:[a-f0-9]{64}$/.test(baseId), "invalid_base_image");
    report.baseImageId = baseId;
    for (const kind of ["container", "volume", "network", "image"])
      requireSafe(await inspect(kind, names[kind]) === null, "resource_collision");
    requireSafe(await inspect("image", names.base) === null, "resource_collision");
    const profile = path.join(ROOT, "docker/desktop/seccomp_profile.json");
    const profileBytes = (await readFile(profile, "utf8")).replace(/\r\n/g, "\n");
    requireSafe(createHash("sha256").update(profileBytes).digest("hex") === PROFILE_HASH, "seccomp_pin_changed");
    report.seccompSha256 = PROFILE_HASH;
    const context = path.join(directory, "context");
    await safeDirectory(context);
    for (const file of ["network-namespace.py", "network-namespace.Dockerfile"])
      await copyFile(path.join(ROOT, "scripts/spikes", file), path.join(context, file));
    tagged = true;
    await output(["image", "tag", baseId, names.base]);
    created.add("image");
    await output(["build", "--network", "none", "--pull=false", "--label", `${LABEL}=${names.run}`,
      "--build-arg", `DESKTOP_IMAGE=${names.base}`, "-f", path.join(context, "network-namespace.Dockerfile"), "-t", names.image, context], { timeout: 90000 });
    const image = await inspect("image", names.image); imageId = image.Id;
    validateResource("image", image, names, imageId); report.fixtureImageId = imageId;
    created.add("network");
    await output(["network", "create", "--internal", "--label", `${LABEL}=${names.run}`, names.network]);
    validateResource("network", await inspect("network", names.network), names, imageId);
    created.add("volume");
    await output(["volume", "create", "--label", `${LABEL}=${names.run}`, names.volume]);
    validateResource("volume", await inspect("volume", names.volume), names, imageId);
    created.add("container");
    await output(createArgs(names, profile));
    const container = await inspect("container", names.container);
    report.runtime = { appArmor: container.AppArmorProfile, readOnly: container.HostConfig.ReadonlyRootfs,
      capabilityAdd: container.HostConfig.CapAdd, capabilityDrop: container.HostConfig.CapDrop,
      securityOptionKinds: container.HostConfig.SecurityOpt.map((item) => item.split(/[=:]/)[0]),
      noPublishedPorts: !Object.keys(container.HostConfig.PortBindings).length,
      environmentKeys: container.Config.Env.map((item) => item.split("=")[0]), command: container.Config.Cmd,
      mountTypes: container.Mounts.map((mount) => ({ type: mount.Type, destination: mount.Destination, name: mount.Name })),
      tmpfsKeys: Object.keys(container.HostConfig.Tmpfs), networkNames: Object.keys(container.NetworkSettings.Networks),
      init: container.HostConfig.Init, pidMode: container.HostConfig.PidMode, ipcMode: container.HostConfig.IpcMode };
    validateContainer(container, names, imageId, appArmorAvailable ? "docker-default" : "");
    const active = await invoke(["start", "-a", names.container], { allowFailure: true, timeout: 210000 });
    const measured = JSON.parse(active.output);
    if (active.status !== 0 || measured.error) {
      report.outcome = "blocked"; report.reason = "linux_probe_prerequisite_failed";
      report.probeError = { type: measured.type, errno: measured.errno };
    } else {
      report.measurements = measured; report.candidateOutcome = classify(measured);
      report.outcome = report.candidateOutcome === "passed" && !appArmorAvailable ? "blocked" : report.candidateOutcome;
    }
  } catch (error) {
    const safe = ["linux_amd64_required", "invalid_base_image", "resource_collision", "seccomp_pin_changed", "unsafe_container",
      "unsafe_volume", "unsafe_network", "cleanup_identity_refused", "docker_command_failed", "docker_timeout_or_output_limit", "spike_deadline", "inspect_refused"];
    report.reason = safe.includes(error.message) ? error.message : "preflight_or_report_failed";
  } finally {
    const failures = [];
    for (const kind of ["container", "volume", "network", "image"]) {
      if (!created.has(kind)) continue;
      try {
        const current = await inspect(kind, names[kind], true);
        if (current) {
          validateResource(kind, current, names, imageId ?? (kind === "image" ? current.Id : undefined));
          await output(kind === "container" ? ["rm", "-f", names.container] : [kind, "rm", names[kind]], { cleanup: true });
        }
      } catch { failures.push(kind); }
    }
    if (tagged) {
      try {
        const base = await inspect("image", names.base, true);
        if (base) {
          requireSafe(base.Id === baseId, "base_tag_changed");
          await output(["image", "rm", names.base], { cleanup: true });
        }
      } catch { failures.push("base_tag"); }
    }
    try {
      for (const [kind, args] of [["containers", ["ps", "-aq"]], ["volumes", ["volume", "ls", "-q"]],
        ["networks", ["network", "ls", "-q"]], ["images", ["image", "ls", "-q"]]]) {
        const remaining = await output([...args, "--filter", `label=${LABEL}=${names.run}`], { cleanup: true });
        if (remaining) failures.push(`remaining_${kind}`);
      }
      const after = await snapshot(true);
      report.missingExistingResources = baseline ? Object.fromEntries(Object.keys(baseline).map((kind) =>
        [kind, baseline[kind].filter((item) => !after[kind].includes(item))])) : null;
      report.existingResourcesUnchanged = baseline ? Object.values(report.missingExistingResources).every((items) => !items.length) : false;
    } catch { failures.push("independent_enumeration"); }
    report.cleanup = failures.length ? "failed" : "complete";
    report.cleanupFailures = failures;
    report.outcome = finalize(report.outcome, report.cleanup, report.existingResourcesUnchanged);
    report.elapsedMs = Date.now() - started;
    await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }
  return { reportPath: path.join(directory, "report.json"), report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { report, reportPath } = await runSpike();
  console.log(JSON.stringify({ reportPath, outcome: report.outcome, reason: report.reason, cleanup: report.cleanup }));
  if (report.outcome !== "passed") process.exitCode = 1;
}
