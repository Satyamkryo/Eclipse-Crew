import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { readFile, writeFile, access, mkdtemp, realpath, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { minimalEnvironment, reserveEvidence } from "../scripts/spikes/volume-isolation.mjs";
import { fetchPackage, fetchPackages, validateEntry, validateManifest } from "../docker/desktop/fetch-packages.mjs";
import { SETUP_CAPS } from "../scripts/desktop-agent.mjs";

const SECCOMP_PROFILE = path.resolve("docker/desktop/seccomp_profile.json");
const SECCOMP_SHA256 = "fa1e603f170044c931a103bfbe3bac6cfc6c935bdc72408e01c4cf6425cde627";
const UPSTREAM_CANONICAL_SHA256 = "8e3abd795acf8d96f90d4f2103f2b9665c21ab645df244d4eedcc5c95ceac3a2";

function validateDesktop(value, { smoke = false, imageId } = {}) {
  assert.equal(value.Config.User, smoke ? "65534:65534" : "0:0");
  assert.equal(value.Image, imageId);
  assert.equal(value.HostConfig.ReadonlyRootfs, true); assert.equal(value.HostConfig.Privileged, false);
  assert.deepEqual(value.HostConfig.CapDrop, ["ALL"]);
  if (smoke) assert.ok(!value.HostConfig.CapAdd?.length);
  else assert.deepEqual(value.HostConfig.CapAdd.map((name) => name.replace(/^CAP_/, "")).sort(), [...SETUP_CAPS].sort());
  assert.ok(value.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
  const seccomp = value.HostConfig.SecurityOpt.filter((option) => option.startsWith("seccomp="));
  assert.equal(seccomp.length, 1);
  assert.deepEqual(JSON.parse(seccomp[0].slice("seccomp=".length)), JSON.parse(awaitedProfile));
  assert.equal(Object.keys(value.HostConfig.PortBindings ?? {}).length, 0);
  assert.equal(Object.keys(value.NetworkSettings.Ports ?? {}).length, 0);
  assert.equal(value.HostConfig.Init, smoke); assert.equal(value.HostConfig.ShmSize, 134217728);
  assert.deepEqual(Object.keys(value.HostConfig.Tmpfs).sort(), ["/run", "/tmp"]);
  assert.ok((value.Config.Env ?? []).every((entry) => /^(PATH|HOME|PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD|DESKTOP_CONTROL_SECRET|EGRESS_DESKTOP_SECRET)=/.test(entry)));
  assert.ok(!value.HostConfig.Devices?.length); assert.ok(!value.HostConfig.DeviceRequests?.length);
  assert.ok((value.Mounts ?? []).every((mount) => mount.Type === "volume" && mount.Destination === "/workspace"));
  if (smoke) {
    assert.equal(value.HostConfig.NetworkMode, "none"); assert.equal(value.Mounts.length, 0);
  } else {
    assert.equal(value.Mounts.length, 1); assert.equal(value.Mounts[0].Type, "volume");
  }
}
const awaitedProfile = await readFile(SECCOMP_PROFILE, "utf8");
test("desktop inspection rejects public ports, credentials, host mounts, privilege and wrong image", () => {
  const fixture = { Image: "expected", Config: { User: "65534:65534", Env: ["PATH=/usr/bin", "HOME=/tmp", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1"] },
    HostConfig: { ReadonlyRootfs: true, Privileged: false, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true", `seccomp=${awaitedProfile}`], Init: true,
      ShmSize: 134217728, Tmpfs: { "/tmp": "size=536870912", "/run": "size=16777216" }, NetworkMode: "none" },
    NetworkSettings: { Ports: {} }, Mounts: [] };
  validateDesktop(fixture, { smoke: true, imageId: "expected" });
  for (const mutate of [(v) => { v.Config.User = "0:0"; }, (v) => { v.HostConfig.CapAdd = ["SYS_ADMIN"]; },
    (v) => { v.Config.Env.push("MODEL_API_KEY=canary"); }, (v) => { v.HostConfig.SecurityOpt = ["seccomp=unconfined"]; },
    (v) => { v.HostConfig.PortBindings = { "5901/tcp": [{ HostPort: "5901" }] }; },
    (v) => { v.Mounts.push({ Type: "bind", Destination: "/workspace" }); }, (v) => { v.Image = "foreign"; }]) {
    const modified = structuredClone(fixture); mutate(modified);
    assert.throws(() => validateDesktop(modified, { smoke: true, imageId: "expected" }));
  }
});
test("desktop inputs preserve approved package pins and browser sandbox constraints", async () => {
  assert.equal(createHash("sha256").update(awaitedProfile.replace(/\r\n/g, "\n")).digest("hex"), SECCOMP_SHA256);
  const profile = JSON.parse(awaitedProfile); const addition = profile.syscalls.pop();
  assert.deepEqual(addition.names, ["chroot"]); assert.equal(addition.action, "SCMP_ACT_ALLOW");
  assert.equal(createHash("sha256").update(JSON.stringify(profile)).digest("hex"), UPSTREAM_CANONICAL_SHA256);
  const dockerfile = await readFile("docker/desktop/Dockerfile", "utf8");
  assert.match(dockerfile, /RUN --network=none --mount=.*from=package_archives/);
  assert.match(dockerfile, /apt-get --no-download install/);
  assert.doesNotMatch(dockerfile, /apt-get.*update|snapshot\.ubuntu\.com/);
  assert.match(dockerfile, /65eedec10a9948b2168e37ba70a6ada69a9c5d9bf3078e2733a371fd1f011d15/);
  assert.match(dockerfile, /48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75/);
  assert.match(dockerfile, /USER 65534:65534/);
  assert.doesNotMatch(dockerfile, /--allow-unauthenticated|Verify-Peer[ =]+false|npm (?:install|i)\b|playwright install/);
  const lock = JSON.parse(await readFile("docker/desktop/package-lock.json", "utf8"));
  assert.equal(lock.packages["node_modules/playwright-core"].version, "1.64.1");
  assert.ok(lock.packages["node_modules/playwright-core"].integrity.startsWith("sha512-"));
  const smoke = await readFile("docker/desktop/smoke.mjs", "utf8");
  assert.match(smoke, /chromiumSandbox: true/);
  assert.doesNotMatch(smoke, /--no-sandbox|--disable-setuid-sandbox/);
});

test("package lock has the approved digest and refuses a mutated manifest or unsafe source entry", async () => {
  const original = await readFile("docker/desktop/ubuntu-packages.lock.json");
  const manifest = validateManifest(original); assert.equal(manifest.packages.length, 388);
  validateManifest(Buffer.from(original.toString().replace(/\n/g, "\r\n")));
  assert.throws(() => validateManifest(Buffer.from(original.toString().replace('"schema": 1', '"schema": 2'))));
  const entry = manifest.packages[0];
  for (const change of [{ filename: "../../outside.deb" }, { url: "https://example.com/ubuntu/pool/main/p/file.deb" },
    { url: "http://archive.ubuntu.com/ubuntu/pool/main/p/file.deb" }, { url: "https://user:password@archive.ubuntu.com/ubuntu/pool/main/p/file.deb" },
    { url: "https://archive.ubuntu.com/ubuntu/pool/%2e%2e/private/file.deb" }, { url: "https://archive.ubuntu.com/ubuntu/pool/main/p/file.deb?token=canary" },
    { sha256: "invalid" }, { bytes: 0 }, { architecture: "arm64" }]) assert.throws(() => validateEntry({ ...entry, ...change }));
});
test("package downloader preserves verified bytes and rejects corruption, size mismatch, redirects and HTTP failure", async () => {
  const root = await realpath(tmpdir()); const directory = await mkdtemp(path.join(root, "eclipse010-package-test-"));
  const bytes = Buffer.from("synthetic archive"); const sha256 = createHash("sha256").update(bytes).digest("hex");
  const entry = { name: "test-package", version: "1.0", architecture: "all", filename: "test-package_1.0_all.deb",
    url: "https://archive.ubuntu.com/ubuntu/pool/main/t/test-package/test-package_1.0_all.deb", bytes: bytes.length, sha256 };
  try {
    for (const response of [new Response("bad", { status: 503 }), new Response(bytes, { headers: { "content-length": "1" } }),
      new Response(Buffer.alloc(bytes.length)), new Response(Buffer.alloc(bytes.length + 1))]) {
      await assert.rejects(fetchPackage(entry, directory, { fetchImpl: async (_, options) => {
        assert.equal(options.redirect, "error"); return response;
      } }));
      assert.deepEqual(await readdir(directory), []);
    }
    await assert.rejects(fetchPackage(entry, directory, { fetchImpl: async () => { throw Error("redirect refused"); } }));
    await fetchPackage(entry, directory, { fetchImpl: async () => new Response(bytes) });
    assert.deepEqual(await readFile(path.join(directory, `${sha256}.deb`)), bytes);
    assert.deepEqual(await readdir(directory), [`${sha256}.deb`]);
  } finally {
    const resolved = await realpath(directory); assert.equal(path.dirname(resolved), root);
    assert.ok(path.basename(resolved).startsWith("eclipse010-package-test-")); await rm(resolved, { recursive: true, force: true });
  }
});

test("parallel package accounting includes every verified archive when completions arrive out of order", async () => {
  const root = await realpath(tmpdir()); const directory = await mkdtemp(path.join(root, "eclipse010-package-test-"));
  const entries = Array.from({ length: 8 }, (_, i) => {
    const bytes = Buffer.alloc(i + 1, i); return { name: `test-package-${i}`, version: "1.0", architecture: "all",
      filename: `test-package-${i}_1.0_all.deb`, url: `https://archive.ubuntu.com/ubuntu/pool/main/t/test-package/file-${i}.deb`,
      bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  try {
    const result = await fetchPackages(entries, directory, { fetchImpl: async (url) => {
      const i = +/file-(\d)/.exec(url)[1]; await new Promise((resolve) => setTimeout(resolve, (8 - i) * 3));
      return new Response(Buffer.alloc(i + 1, i));
    } });
    assert.deepEqual(result, { packages: 8, bytes: 36 }); assert.equal((await readdir(directory)).length, 8);
  } finally {
    const resolved = await realpath(directory); assert.equal(path.dirname(resolved), root);
    assert.ok(path.basename(resolved).startsWith("eclipse010-package-test-")); await rm(resolved, { recursive: true, force: true });
  }
});

test("real pinned desktop image and isolated Compose smoke", { timeout: 1200000 }, async () => {
  const run = randomBytes(12).toString("hex"); const project = `eclipse010${run}`;
  const evidence = await reserveEvidence(path.resolve("data/spikes/task-010"));
  const summary = { task: "TASK-010", runId: evidence.runId, mode: "docker", outcome: "incomplete", stage: "build", cleanup: "pending" };
  let dockerPath = "docker";
  if (process.platform === "win32") {
    const installed = "E:\\Apps\\Docker\\resources\\bin\\docker.exe";
    try { await access(installed); dockerPath = installed; } catch { /* Other installations use PATH. */ }
  }
  const bootstrap = randomBytes(24).toString("hex"); const app = randomBytes(24).toString("hex"); const migrator = randomBytes(24).toString("hex");
  const desktopSecret = randomBytes(32).toString("hex");
  const env = { ...minimalEnvironment(), POSTGRES_BOOTSTRAP_PASSWORD: bootstrap, POSTGRES_APP_PASSWORD: app,
    POSTGRES_MIGRATOR_PASSWORD: migrator, DATABASE_URL: `postgresql://eclipse_app:${app}@postgres:5432/eclipse`,
    DESKTOP_CONTROL_SECRET: desktopSecret };
  const emptyEnv = path.join(evidence.directory, "empty.env"); const override = path.join(evidence.directory, "compose.override.json");
  await writeFile(emptyEnv, "", { flag: "wx", mode: 0o600 });
  await writeFile(override, JSON.stringify({ services: { desktop: { labels: { "ai.eclipse.task010.run": run },
    build: { labels: { "ai.eclipse.task010.run": run } } } } }), { flag: "wx", mode: 0o600 });
  const prefix = ["compose", "--env-file", emptyEnv, "--project-name", project, "--file", path.resolve("docker-compose.yml"), "--file", override];
  const execute = (args, timeout = 60000) => spawnSync(dockerPath, args, { env, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  const checked = (args, timeout) => {
    const value = execute(args, timeout);
    // Compose config legitimately resolves synthetic DB settings in memory; it is
    // never logged or written. All stderr and other command output remain scanned.
    const scanned = args.includes("config") ? (value.stderr ?? "") : `${value.stdout ?? ""}${value.stderr ?? ""}`
      .replaceAll(JSON.stringify(`DESKTOP_CONTROL_SECRET=${desktopSecret}`), '"DESKTOP_CONTROL_SECRET=[private]"');
    for (const secret of [bootstrap, app, migrator, desktopSecret]) assert.ok(!scanned.includes(secret), "synthetic credential leaked");
    if (value.status !== 0) {
      if (/snapshot\.ubuntu\.com/.test(value.stderr) && /50[234]|[Cc]ertificate|Failed to fetch/.test(value.stderr)) summary.reason = "apt_snapshot_unavailable";
      assert.fail(summary.reason ?? `docker_command_failed_in_${summary.stage}`);
    }
    return value.stdout.trim();
  };
  const compose = (args, timeout) => checked([...prefix, ...args], timeout);
  const smokeName = `${project}-smoke`; const desktopTag = `${project}-desktop:latest`;
  let imageId; let created = false;
  try {
    const config = JSON.parse(compose(["config", "--format", "json"]));
    const desktop = config.services.desktop;
    assert.equal(desktop.build.context, path.resolve("docker/desktop")); assert.equal(desktop.user, "0:0");
    assert.ok(!desktop.ports?.length && !desktop.secrets?.length);
    assert.ok(!desktop.environment || (Object.keys(desktop.environment).sort().join(",") === "DESKTOP_CONTROL_SECRET,EGRESS_DESKTOP_SECRET"));
    assert.deepEqual(desktop.cap_drop, ["ALL"]); assert.deepEqual(desktop.cap_add.sort(), [...SETUP_CAPS].sort());
    assert.equal(desktop.init, false); assert.ok(config.networks.desktop.internal);
    assert.ok(desktop.security_opt.some((value) => value.startsWith("seccomp=")));
    for (const [service, value] of Object.entries(config.services)) if (service !== "desktop")
      assert.ok(!(value.security_opt ?? []).some((option) => option.startsWith("seccomp=")), "profile must be desktop-only");
    assert.deepEqual(desktop.volumes.map((mount) => [mount.type, mount.source, mount.target]), [["volume", "workspace", "/workspace"]]);
    created = true;
    compose(["build", "desktop"], 600000);
    const [image] = JSON.parse(checked(["image", "inspect", desktopTag]));
    assert.ok(image.RepoTags.includes(desktopTag)); assert.equal(image.Config.Labels["ai.eclipse.task010.run"], run); imageId = image.Id;
    summary.stage = "compose";
    compose(["up", "-d", "--no-build", "desktop"]);
    summary.composePsVerified = JSON.parse(compose(["ps", "--format", "json"])).State === "running";
    assert.ok(summary.composePsVerified);
    const desktopId = compose(["ps", "-q", "desktop"]);
    const [container] = JSON.parse(checked(["inspect", desktopId])); validateDesktop(container, { imageId });
    for (let i = 0; i < 80; i++) {
      const health = checked(["inspect", "--format", "{{.State.Health.Status}}", desktopId]);
      if (health === "healthy") break;
      if (i === 79) assert.fail("desktop_health_unavailable");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    summary.idleHealth = "healthy";
    const supervisorStatus = checked(["exec", desktopId, "node", "-e", "console.log(require('node:fs').readFileSync('/proc/1/status','utf8'))"]);
    for (const field of ["CapEff", "CapPrm", "CapBnd"]) assert.match(supervisorStatus, new RegExp(`^${field}:\\s+00000000000001c3$`, "m"));
    assert.match(supervisorStatus, /^NoNewPrivs:\s+1$/m); summary.supervisorSysAdminDropped = true;
    summary.stage = "smoke";
    checked(["create", "--name", smokeName, "--label", `com.docker.compose.project=${project}`, "--label", `ai.eclipse.task010.run=${run}`,
      "--network", "none", "--read-only", "--user", "65534:65534", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--security-opt", `seccomp=${SECCOMP_PROFILE}`,
      "--init", "--shm-size", "128m", "--tmpfs", "/tmp:uid=65534,gid=65534,mode=1777,size=536870912",
      "--tmpfs", "/run:uid=65534,gid=65534,mode=755,size=16777216", desktopTag, "node", "/opt/eclipse/desktop/smoke.mjs"]);
    const [smokeContainer] = JSON.parse(checked(["inspect", smokeName])); validateDesktop(smokeContainer, { smoke: true, imageId });
    const smokeRun = execute(["start", "--attach", smokeName], 120000);
    const lines = smokeRun.stdout.trim().split(/\r?\n/); const smoke = JSON.parse(lines.at(-1));
    // Persist only the smoke's bounded, whitelisted status, not arbitrary container output.
    const checks = ["tool_inventory_and_nonroot_identity", "authenticated_xvfb_and_openbox", "authenticated_vnc_and_novnc_websocket_transport",
      "x11_png_and_three_frame_video", "sandboxed_chromium_playwright_and_xdotool"];
    const reasons = new Set(["identity_invalid", "privilege_invalid", "sudo_present", "display_unavailable", "x11_authentication_missing",
      "window_manager_unavailable", "vnc_unavailable", "rfb_version_invalid", "rfb_security_invalid", "vnc_authentication_missing",
      "unauthenticated_vnc_not_rejected", "vnc_authentication_failed", "novnc_unavailable", "websocket_timeout", "websocket_rfb_invalid", "websocket_unavailable",
      "capture_invalid", "video_invalid", "chromium_sandbox_unavailable", "chromium_launch_failed", "playwright_input_failed", "xdotool_input_failed",
      "smoke_command_failed", "rfb_timeout", "rfb_closed", "toolchain_check_failed", "outer_chroot_not_denied", "browser_sandbox_not_verified"]);
    summary.smoke = { outcome: smoke.outcome === "passed" ? "passed" : "incomplete", stage: ["identity", "display", "vnc", "capture", "browser", "complete"].includes(smoke.stage) ? smoke.stage : "unknown",
      checks: (smoke.checks ?? []).filter((check) => checks.includes(check.name) && check.passed === true),
      ...(reasons.has(smoke.reason) ? { reason: smoke.reason } : {}) };
    if (smoke.versions) summary.versions = Object.fromEntries(Object.entries(smoke.versions).filter(([key, value]) =>
      ["node", "playwright", "chromium", "openbox", "xdotool", "ffmpeg", "x11vnc", "websockify", "xvfb", "novnc", "git"].includes(key) && /^[\w.+:~\-]{1,80}$/.test(value)));
    if (smoke.sandbox?.namespace === true && smoke.sandbox?.seccompBpf === true) summary.sandbox = { namespace: true, seccompBpf: true };
    assert.equal(summary.sandbox?.namespace, true, "browser_namespace_sandbox_not_verified");
    assert.equal(summary.sandbox?.seccompBpf, true, "browser_seccomp_sandbox_not_verified");
    assert.equal(smokeRun.status, 0, summary.smoke.reason ?? "desktop_smoke_failed");
    assert.equal(summary.smoke.outcome, "passed"); assert.equal(summary.smoke.checks.length, 5);
    summary.outcome = "passed"; summary.stage = "complete";
  } catch (error) {
    if (!summary.reason) summary.reason = summary.smoke?.reason ?? `validation_failed_in_${summary.stage}`;
    throw error;
  } finally {
    try {
      if (created) {
        // Check ownership of every project resource before any destructive command.
        for (const [kind, list] of [["container", ["ps", "-aq"]], ["network", ["network", "ls", "-q"]], ["volume", ["volume", "ls", "-q"]]]) {
          const ids = checked([...list, "--filter", `label=com.docker.compose.project=${project}`]).split(/\r?\n/).filter(Boolean);
          for (const id of ids) {
            const format = kind === "container" ? '{{ index .Config.Labels "com.docker.compose.project" }}' : '{{ index .Labels "com.docker.compose.project" }}';
            assert.equal(checked([kind, "inspect", "--format", format, id]), project);
            if (kind === "volume") {
              const [volume] = JSON.parse(checked(["volume", "inspect", id]));
              assert.equal(volume.Driver, "local"); assert.equal(Object.keys(volume.Options ?? {}).length, 0);
              assert.equal(volume.Labels["com.docker.compose.volume"], "workspace");
            }
          }
        }
        const remaining = checked(["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=ai.eclipse.task010.run=${run}`]).split(/\r?\n/).filter(Boolean);
        for (const id of remaining) checked(["rm", "--force", id]);
        compose(["down", "--volumes", "--remove-orphans"]);
        const found = execute(["image", "inspect", desktopTag]);
        if (found.status === 0) {
          const [image] = JSON.parse(found.stdout); assert.ok(image.RepoTags.includes(desktopTag)); assert.equal(image.Config.Labels["ai.eclipse.task010.run"], run);
          checked(["image", "rm", desktopTag]);
        } else assert.equal(found.stdout.trim(), "[]");
      }
      summary.cleanup = "complete";
    } catch {
      summary.cleanup = "refused"; summary.outcome = "incomplete"; summary.remainingProject = project;
    }
    await writeFile(path.join(evidence.directory, "result.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(`TASK-010 evidence: data/spikes/task-010/${evidence.runId}/result.json`);
    assert.equal(summary.cleanup, "complete", "scoped_cleanup_refused");
  }
});
