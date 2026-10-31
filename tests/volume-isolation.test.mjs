import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { minimalEnvironment, reserveEvidence, resources, runProcess, runSpike, validateCompose, validateContainer, validateImage, validateVolume } from "../scripts/spikes/volume-isolation.mjs";

const names = resources("0123456789abcdef01234567");
const labels = { "ai.eclipse.task009.run": names.run, "com.docker.compose.project": names.project };
function volume() { return { Name: names.volume, Driver: "local", Options: null, Labels: { ...labels, "com.docker.compose.volume": "homes" } }; }
function image() { return { Id: "sha256:test", RepoTags: [names.image], Config: { User: "20001:20001", Labels: labels } }; }
function container() {
  return { Id: "test-container", Name: `/${names.container}`, Image: image().Id,
    Config: { User: "20001:20001", Labels: { ...labels, "com.docker.compose.service": "probe" }, Env: ["PATH=/usr/bin:/bin"] },
    HostConfig: { ReadonlyRootfs: true, NetworkMode: "none", Privileged: false, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"], PortBindings: {} },
    Mounts: [{ Type: "volume", Name: names.volume, Destination: "/home", RW: true }], NetworkSettings: { Ports: {}, Networks: { none: {} } } };
}
function config() {
  return { services: { probe: { image: names.image, user: "20001:20001", read_only: true, network_mode: "none", cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"], labels, build: { network: "none", labels },
    volumes: [{ type: "volume", source: "homes", target: "/home" }] } },
  volumes: { homes: { name: names.volume, driver: "local", labels } } };
}
const refuses = (fn, code) => assert.throws(fn, (error) => error.code === code);

test("cleanup rejects foreign labels, nonlocal volume drivers and unsafe image identities", () => {
  validateVolume(volume(), names); validateImage(image(), names);
  for (const change of [{ Name: "main_workspace" }, { Driver: "nfs" }, { Options: { device: "/host" } },
    { Labels: { ...labels, "com.docker.compose.volume": "workspace" } }, { Labels: { ...volume().Labels, "ai.eclipse.task009.run": "other" } }]) {
    refuses(() => validateVolume({ ...volume(), ...change }, names), "unsafe_volume");
  }
  for (const change of [{ RepoTags: ["main-app:latest"] }, { Config: { ...image().Config, User: "root" } }, { Config: { ...image().Config, Labels: {} } }])
    refuses(() => validateImage({ ...image(), ...change }, names), "unsafe_image");
  for (const run of ["../workspace", "", "A".repeat(24), "a".repeat(25)]) refuses(() => resources(run), "invalid_run");
});

test("runtime inspection refuses host mounts, capabilities, secrets, published ports and different users", () => {
  validateContainer(container(), names, image().Id);
  const namedVolumeBinding = container(); namedVolumeBinding.HostConfig.Binds = [`${names.volume}:/home:rw`];
  validateContainer(namedVolumeBinding, names, image().Id);
  const changed = (fn) => { const value = container(); fn(value); refuses(() => validateContainer(value, names, image().Id), "unsafe_container"); };
  changed((c) => { c.Config.Env.push("MODEL_API_KEY=synthetic"); });
  changed((c) => { c.Config.User = "0:0"; });
  changed((c) => { c.Image = "other"; });
  changed((c) => { c.Config.Labels["ai.eclipse.task009.run"] = "other"; });
  changed((c) => { c.HostConfig.ReadonlyRootfs = false; });
  changed((c) => { c.HostConfig.CapAdd = ["DAC_OVERRIDE"]; });
  changed((c) => { c.HostConfig.Privileged = true; });
  changed((c) => { c.HostConfig.NetworkMode = "default"; });
  changed((c) => { c.HostConfig.PortBindings = { "3000/tcp": [{ HostPort: "3000" }] }; });
  changed((c) => { c.Mounts.push({ Type: "bind", Source: "/host", Destination: "/secrets" }); });
  changed((c) => { c.Mounts[0].Name = "main_workspace"; });
  changed((c) => { c.HostConfig.Binds = ["C:/private:/host:rw"]; });
});

test("effective Compose validation rejects extra services, mounts, env and networks before starting", () => {
  validateCompose(config(), names);
  for (const modify of [(c) => { c.services.app = {}; }, (c) => { c.services.probe.environment = { TOKEN: "synthetic" }; },
    (c) => { c.services.probe.volumes[0].type = "bind"; }, (c) => { c.networks = { default: {} }; },
    (c) => { c.volumes.homes.driver_opts = { device: "/workspace" }; }]) {
    const value = config(); modify(value); refuses(() => validateCompose(value, names), "unsafe_compose");
  }
});

test("host Docker environment excludes provider keys, Compose overrides and runtime injection", () => {
  const env = minimalEnvironment({ PATH: "tool-path", SystemRoot: "system", MODEL_API_KEY: "canary", DATABASE_URL: "canary",
    DOCKER_HOST: "remote", COMPOSE_FILE: "foreign.yml", COMPOSE_PROJECT_NAME: "main", NODE_OPTIONS: "canary", TASK009_IMAGE: "foreign" });
  assert.deepEqual(env, { SystemRoot: "system", PATH: "tool-path" });
});

async function fixture(fn) {
  const root = await realpath(tmpdir()); const directory = await mkdtemp(path.join(root, "eclipse009-test-"));
  try { await fn(directory); }
  finally {
    const resolved = await realpath(directory);
    assert.equal(path.dirname(resolved), root); assert.ok(path.basename(resolved).startsWith("eclipse009-test-"));
    await rm(resolved, { recursive: true, force: true });
  }
}
test("evidence is exclusive and refuses a symlink/junction ancestor", async () => {
  await fixture(async (root) => {
    const first = await reserveEvidence(path.join(root, "evidence")); const second = await reserveEvidence(path.join(root, "evidence"));
    assert.notEqual(first.directory, second.directory);
    const link = path.join(root, "unsafe"); await symlink(first.directory, link, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(reserveEvidence(path.join(link, "nested")), (error) => error.code === "unsafe_evidence");
  });
});

function fakeDocker({ denyProbe = false, unsafeCleanup = false } = {}) {
  const commands = []; let active = false; let built = false; let mounted = false; let recreated = false; let rejected = false;
  let actual;
  const runner = async (_executable, args, options) => {
    commands.push(args);
    assert.ok(!Object.hasOwn(options.env, "MODEL_API_KEY")); assert.ok(!Object.hasOwn(options.env, "DATABASE_URL"));
    actual = resources(options.env.TASK009_RUN);
    const remap = (value) => JSON.parse(JSON.stringify(value).replaceAll(names.project, actual.project).replaceAll(names.run, actual.run));
    const ok = (value) => ({ status: 0, output: typeof value === "string" ? value : JSON.stringify(value) });
    const absent = () => ({ status: 1, output: "[]" });
    if (args[0] === "version") return ok({ Os: "linux", Version: "mock", Arch: "amd64" });
    if (args[0] === "ps" || args[0] === "volume" && args[1] === "ls") return ok("");
    if (args[0] === "inspect") {
      if (!active) return absent();
      const value = remap(container()); if (recreated) value.Id = "recreated";
      if (rejected && unsafeCleanup) value.Config.Labels["ai.eclipse.task009.run"] = "foreign";
      return ok([value]);
    }
    if (args[1] === "inspect") return args[0] === "image" ? built ? ok([remap(image())]) : absent() : mounted ? ok([remap(volume())]) : absent();
    if (args[0] === "compose") {
      assert.equal(await readFile(args[2], "utf8"), "");
      const command = args[7];
      if (command === "config") return ok(remap(config()));
      if (command === "build") { built = true; return ok(""); }
      if (command === "up") { if (active) recreated = true; active = true; mounted = true; return ok(""); }
      if (command === "ps") return ok({ Service: "probe", State: "running" });
    }
    if (args[0] === "exec") {
      assert.ok(options.input.startsWith("#!/bin/bash\n"));
      assert.deepEqual(args.slice(7, 13), ["timeout", "--kill-after=2s", "60s", "bash", "-s", "--"]);
      if (denyProbe) { rejected = true; return { status: 1, output: "" }; }
      const phase = args[13]; const agent = args[14];
      return ok(phase === "bench" ? { phase, agent, round: +args[17], files: 1000, fileBytes: 4096, sequentialBytes: 33554432,
        checksumVerified: true, createNs: 100, readNs: 100, renameNs: 100, deleteNs: 100, writeNs: 100, sequentialReadNs: 100 } :
      { phase, agent, passed: true, checks: 10 });
    }
    if (args[0] === "rm") { active = false; return ok(""); }
    if (args[1] === "rm") { if (args[0] === "image") built = false; else mounted = false; return ok(""); }
    throw Error("unexpected mock command");
  };
  return { runner, commands, get resources() { return actual; } };
}
test("mock lifecycle checks both identities, recreation, six samples and exact cleanup; evidence is labeled mock", async () => {
  await fixture(async (root) => {
    const fake = fakeDocker();
    const result = await runSpike({ evidenceRoot: root, runner: fake.runner });
    assert.equal(result.summary.outcome, "passed"); assert.equal(result.summary.mode, "mock");
    assert.equal(result.summary.cleanup, "complete"); assert.equal(result.summary.benchmarks.length, 6);
    assert.equal(result.summary.checks.length, 14); assert.equal(result.summary.existingResourcesUnchanged, true);
    const snapshot = fake.commands.find((args) => args[0] === "ps");
    assert.equal(snapshot[snapshot.indexOf("--format") + 1], "{{.ID}} {{.Image}}");
    const executions = fake.commands.filter((args) => args[0] === "exec"); assert.equal(executions.length, 20);
    assert.ok(fake.commands.some((args) => args.includes("--force-recreate")));
    assert.equal(fake.commands.filter((args) => args[0] === "rm").length, 1);
    const directory = path.join(root, result.summary.runId);
    assert.deepEqual((await readdir(directory)).sort(), ["empty.env", "result.json"]);
    assert.equal(JSON.parse(await readFile(path.join(directory, "result.json"), "utf8")).mode, "mock");
  });
});
test("probe failure cannot pass; changed cleanup labels prevent every destructive command", async () => {
  await fixture(async (root) => {
    for (const unsafeCleanup of [false, true]) {
      const fake = fakeDocker({ denyProbe: true, unsafeCleanup });
      const result = await runSpike({ evidenceRoot: root, runner: fake.runner });
      assert.equal(result.summary.outcome, "incomplete"); assert.equal(result.summary.reason, "docker_failed");
      assert.equal(result.summary.cleanup, unsafeCleanup ? "refused" : "complete");
      if (unsafeCleanup) assert.ok(!fake.commands.some((args) => args[0] === "rm" || args[1] === "rm"));
    }
  });
});
test("subprocess deadlines and output bounds do not report successful work", async () => {
  const timeout = await runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeout: 100, env: minimalEnvironment() });
  assert.equal(timeout.timedOut, true);
  const large = await runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(2*1024*1024))"], { env: minimalEnvironment() });
  assert.equal(large.oversized, true);
});
test("CLI help and unknown arguments cannot trigger Docker or leak environment", () => {
  const cli = path.resolve("scripts/spikes/volume-isolation.mjs");
  const options = { encoding: "utf8", env: { ...minimalEnvironment(), MODEL_API_KEY: "SYNTHETIC_CANARY" } };
  const help = spawnSync(process.execPath, [cli, "--help"], options); assert.equal(help.status, 0);
  const invalid = spawnSync(process.execPath, [cli, "--foreign"], options); assert.equal(invalid.status, 1);
  assert.ok(!(invalid.stdout + invalid.stderr).includes("SYNTHETIC_CANARY"));
});
