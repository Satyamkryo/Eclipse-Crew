import { spawnSync, spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { minimalEnvironment } from "./spikes/volume-isolation.mjs";
import { validateIds } from "../docker/desktop/agent-store.mjs";

export const SETUP_CAPS = ["CHOWN", "DAC_OVERRIDE", "SETUID", "SETGID", "SETPCAP", "SYS_ADMIN"];
export function validateDesktopTarget(value, project, profile) {
  const host = value?.HostConfig;
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project) || value?.Config?.Labels?.["com.docker.compose.project"] !== project ||
      value.Config.Labels["com.docker.compose.service"] !== "desktop" || value.Config.User !== "0:0" ||
      value.State?.Running !== true || value.State.Health?.Status !== "healthy" || host?.ReadonlyRootfs !== true || host.Privileged || host.Init ||
      JSON.stringify(host.CapDrop) !== '["ALL"]' || JSON.stringify((host.CapAdd ?? []).map((name) => name.replace(/^CAP_/, "")).sort()) !== JSON.stringify([...SETUP_CAPS].sort()) ||
      !host.SecurityOpt?.includes("no-new-privileges:true") || Object.keys(host.PortBindings ?? {}).length || Object.keys(value.NetworkSettings?.Ports ?? {}).length ||
      host.Devices?.length || host.DeviceRequests?.length || value.Mounts?.length !== 1 || value.Mounts[0].Type !== "volume" ||
      value.Mounts[0].Destination !== "/workspace" || value.Mounts[0].RW !== true ||
      !(value.Config.Env ?? []).every((entry) => /^(PATH|HOME|PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD|DESKTOP_CONTROL_SECRET|EGRESS_DESKTOP_SECRET)=/.test(entry))) throw Error("desktop_security_refused");
  const policies = host.SecurityOpt.filter((value) => value.startsWith("seccomp="));
  if (policies.length !== 1 || JSON.stringify(JSON.parse(policies[0].slice(8))) !== JSON.stringify(profile)) throw Error("desktop_security_refused");
}
export function validateWorkspace(value, project, name) {
  if (value?.Name !== name || value.Driver !== "local" || Object.keys(value.Options ?? {}).length ||
      value.Labels?.["com.docker.compose.project"] !== project || value.Labels?.["com.docker.compose.volume"] !== "workspace") throw Error("workspace_security_refused");
}
export async function desktopAgent({ command, ownerId, agentId, argv = [], project = process.env.COMPOSE_PROJECT_NAME ?? path.basename(process.cwd()).toLowerCase(), dockerPath } = {}) {
  if (!["create", "inspect", "exec", "session-start", "session-status", "session-stop"].includes(command) || command !== "exec" && argv.length || command === "exec" && !argv.length) throw Error("invalid_arguments");
  validateIds(ownerId, agentId);
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) throw Error("invalid_project");
  if (!dockerPath) {
    dockerPath = "docker";
    if (process.platform === "win32") {
      const installed = "E:\\Apps\\Docker\\resources\\bin\\docker.exe";
      try { await access(installed); dockerPath = installed; } catch { /* PATH on other installations. */ }
    }
  }
  const env = minimalEnvironment();
  const read = (args) => {
    const result = spawnSync(dockerPath, args, { env, encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
    if (result.status !== 0) throw Error("desktop_unavailable"); return result.stdout.trim();
  };
  const candidates = read(["ps", "-q", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=com.docker.compose.service=desktop"]).split(/\r?\n/).filter(Boolean);
  if (candidates.length !== 1 || !/^[a-f0-9]{12,64}$/.test(candidates[0])) throw Error("desktop_unavailable");
  const [container] = JSON.parse(read(["inspect", candidates[0]]));
  validateDesktopTarget(container, project, JSON.parse(await readFile("docker/desktop/seccomp_profile.json", "utf8")));
  const [volume] = JSON.parse(read(["volume", "inspect", container.Mounts[0].Name]));
  validateWorkspace(volume, project, container.Mounts[0].Name);
  return new Promise((resolve, reject) => {
    const child = spawn(dockerPath, ["exec", "--user", "0:0", candidates[0], "python3", "/opt/eclipse/desktop/bootstrap.py", "--admin", command, ownerId, agentId, ...argv],
      { env, stdio: "inherit", shell: false, windowsHide: true });
    child.once("error", () => reject(Error("desktop_unavailable"))); child.once("close", (code) => resolve(code ?? 1));
  });
}
async function main() {
  try {
    const { values, positionals } = parseArgs({ options: { owner: { type: "string" }, agent: { type: "string" }, project: { type: "string" }, help: { type: "boolean" } }, allowPositionals: true });
    if (values.help) { console.log("Usage: npm run desktop:agent -- <create|inspect|exec|session-start|session-status|session-stop> --owner UUID --agent UUID [--project NAME] [-- COMMAND ARGS]"); return; }
    const [command, ...argv] = positionals;
    process.exitCode = await desktopAgent({ command, ownerId: values.owner, agentId: values.agent, project: values.project, argv });
  } catch { console.error('{"outcome":"refused","reason":"desktop_admin_refused"}'); process.exitCode = 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
