import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resources, createArgs, validateContainer, validateResource, classify, finalize, runSpike, LABEL } from "../scripts/spikes/network-namespace.mjs";

const names = resources("0123456789abcdef01234567");
const imageId = `sha256:${"a".repeat(64)}`;
function fixture() {
  return { Name: `/${names.container}`, Image: imageId, AppArmorProfile: "docker-default",
    Config: { Labels: { [LABEL]: names.run }, User: "0:0", Entrypoint: ["python3", "/opt/eclipse/network-namespace.py"],
      Cmd: [], Env: ["PATH=/usr/bin", "HOME=/tmp", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1"] },
    HostConfig: { ReadonlyRootfs: true, Privileged: false, Init: false, CapDrop: ["ALL"],
      CapAdd: ["CHOWN", "DAC_OVERRIDE", "SETUID", "SETGID", "SETPCAP", "SYS_ADMIN"],
      SecurityOpt: ["no-new-privileges:true", "seccomp={pinned}"], NetworkMode: names.network,
      PortBindings: {}, Tmpfs: { "/run": "", "/tmp": "" } },
    Mounts: [{ Type: "volume", Name: names.volume, Destination: "/workspace", RW: true }],
    NetworkSettings: { Networks: { [names.network]: {} } } };
}

test("resource names reject arbitrary cleanup selectors and all args are discrete", () => {
  for (const run of ["", "../main", "main-*", "A".repeat(24), "a".repeat(25)]) assert.throws(() => resources(run));
  const args = createArgs(names, "E:/path with spaces/profile.json");
  assert.ok(args.includes("seccomp=E:/path with spaces/profile.json"));
  assert.equal(args.at(-1), names.image);
  assert.ok(!args.includes("--privileged") && !args.includes("--publish"));
});

test("container guards accept the bounded fixture and refuse security regressions", () => {
  assert.doesNotThrow(() => validateContainer(fixture(), names, imageId));
  const mutations = [
    (value) => { value.Config.Env.push("ENCRYPTION_KEY=synthetic"); },
    (value) => { value.HostConfig.Privileged = true; },
    (value) => { value.HostConfig.CapAdd.push("NET_ADMIN"); },
    (value) => { value.HostConfig.ReadonlyRootfs = false; },
    (value) => { value.HostConfig.SecurityOpt = ["seccomp=unconfined"]; },
    (value) => { value.AppArmorProfile = "unconfined"; },
    (value) => { value.HostConfig.NetworkMode = "host"; },
    (value) => { value.HostConfig.PortBindings = { "4310/tcp": [{}] }; },
    (value) => { value.Mounts[0].Name = "main_workspace"; },
    (value) => { value.Mounts.push({ Type: "bind", Source: "/var/run/docker.sock" }); },
    (value) => { value.HostConfig.Binds = ["/tmp:/host"]; },
    (value) => { value.HostConfig.PidMode = "host"; },
    (value) => { value.Config.Cmd = ["sleep", "infinity"]; },
    (value) => { value.NetworkSettings.Networks.other = {}; },
  ];
  for (const mutate of mutations) {
    const value = fixture(); mutate(value);
    assert.throws(() => validateContainer(value, names, imageId), /unsafe_container/);
  }
});

test("cleanup validates owner label, exact name/image and volume/network boundaries", () => {
  assert.doesNotThrow(() => validateResource("container", fixture(), names, imageId));
  const foreign = fixture(); foreign.Config.Labels[LABEL] = "other";
  assert.throws(() => validateResource("container", foreign, names, imageId));
  assert.throws(() => validateResource("container", fixture(), names, "different-image"));
  const volume = { Name: names.volume, Driver: "local", Labels: { [LABEL]: names.run }, Options: {} };
  assert.doesNotThrow(() => validateResource("volume", volume, names, imageId));
  assert.throws(() => validateResource("volume", { ...volume, Name: "main_workspace" }, names, imageId));
  assert.throws(() => validateResource("volume", { ...volume, Options: { device: "/home" } }, names, imageId));
  const network = { Name: names.network, Internal: true, Driver: "bridge", Labels: volume.Labels };
  assert.doesNotThrow(() => validateResource("network", network, names, imageId));
  assert.throws(() => validateResource("network", { ...network, Internal: false }, names, imageId));
});

test("missing measurements, prerequisite failure and blocked checks never pass", () => {
  assert.equal(classify({}), "incomplete");
  const agents = Array.from({ length: 3 }, () => ({ checks: [{ name: "private_namespace_created", status: "fail" }] }));
  assert.equal(classify({ checks: [], agents }), "blocked");
  agents.forEach((agent) => { agent.checks[0].status = "pass"; });
  assert.equal(classify({ checks: [], agents }), "incomplete");
  agents[0].checks[0].status = "invented";
  assert.equal(classify({ checks: [], agents }), "incomplete");
});

test("cleanup failure or changed existing resources override a positive measurement", () => {
  assert.equal(finalize("passed", "failed", true), "incomplete");
  assert.equal(finalize("passed", "complete", false), "incomplete");
  assert.equal(finalize("blocked", "complete", true), "blocked");
  assert.equal(finalize("passed", "complete", true), "passed");
});

test("a complete measured candidate fails on a reachable pathname socket or browser regression", () => {
  const required = ["agent_outer_privileges", "private_namespace_created", "private_localhost", "direct_tcp", "direct_dns_udp",
    "direct_quic_udp", "direct_ipv6", "pathname_socket_boundary", "abstract_socket_boundary", "protected_socket_boundary",
    "bridge_allowed", "bridge_unlisted", "bridge_private", "bridge_metadata", "bridge_forbidden_dns", "bridge_redirect",
    "bridge_forged_identity", "chromium", "inherited_socket_boundary", "outer_network_namespace_requires_privilege",
    "no_outer_interface_or_route", "shared_loopback", "shared_ipv6_loopback", "controller_loopback"];
  const report = { checks: ["supervisor_privilege_reduction", "distinct_and_recreated_namespaces", "sessions_reaped"]
    .map((name) => ({ name, status: "pass" })), agents: Array.from({ length: 3 }, () => ({ checks: required.map((name) => ({ name, status: "pass" })) })) };
  assert.equal(classify(report), "passed");
  report.agents[0].checks.find((item) => item.name === "pathname_socket_boundary").status = "fail";
  assert.equal(classify(report), "failed");
  report.agents[0].checks.find((item) => item.name === "pathname_socket_boundary").status = "pass";
  report.agents[2].checks.find((item) => item.name === "chromium").status = "blocked";
  assert.equal(classify(report), "blocked");
  report.checks.pop();
  assert.equal(classify(report), "incomplete");
});

test("an unavailable Docker engine writes a sanitized incomplete report without pretending cleanup succeeded", async () => {
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "eclipse071-tests-"));
  const { report, reportPath } = await runSpike({ evidenceRoot, runner: async () => {
    throw new Error("synthetic-private-diagnostic");
  } });
  assert.equal(report.outcome, "incomplete");
  assert.equal(report.mode, "mock");
  assert.equal(report.cleanup, "failed");
  assert.ok(report.cleanupFailures.includes("independent_enumeration"));
  assert.ok(!(await readFile(reportPath, "utf8")).includes("synthetic-private-diagnostic"));
});
