import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// TASK-078 spike runner. Uses the exact measured pin from browser-build.lock.json and the
// production read-only/seccomp/zero-capability runtime, writing only a sanitized report.
const root = path.resolve(".");
const image = "eclipse078-spike";
const evidence = path.resolve("test-results/chrome-for-testing");
const docker = process.platform === "win32" ? "E:\\Apps\\Docker\\resources\\bin\\docker.exe" : "docker";
const build = spawnSync(docker, ["build", "-f", "scripts/spikes/chrome-for-testing.Dockerfile", "-t", image, "."],
  { cwd: root, encoding: "utf8", timeout: 900000, windowsHide: true });
if (build.status !== 0) {
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, "spike-build.json"), JSON.stringify({ outcome: "build_failed", output: String(build.stderr).slice(-4000) }) + "\n", { mode: 0o600 });
  console.error(JSON.stringify({ outcome: "spike_build_failed" })); process.exit(1);
}
const seccomp = path.resolve("docker/desktop/seccomp_profile.json");
const run = spawnSync(docker, ["run", "--rm", "--name", "cft-spike", "--network", "none", "--read-only", "--user", "65534:65534",
  "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--security-opt", `seccomp=${seccomp}`, "--init", "--shm-size", "128m",
  "--tmpfs", "/tmp:uid=65534,gid=65534,mode=1777,size=536870912", "--tmpfs", "/run:uid=65534,gid=65534,mode=755,size=16777216", image],
  { encoding: "utf8", timeout: 300000, windowsHide: true });
const line = String(run.stdout).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
let report; try { report = JSON.parse(line); } catch { report = { outcome: "invalid_output" }; }
await mkdir(evidence, { recursive: true });
await writeFile(path.join(evidence, "spike.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(report));
if (run.status !== 0 || report.outcome !== "passed") process.exit(1);
