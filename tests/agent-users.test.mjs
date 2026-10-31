import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { validateIds, validateRegistry } from "../docker/desktop/agent-store.mjs";
import { validateDesktopTarget, validateWorkspace, SETUP_CAPS } from "../scripts/desktop-agent.mjs";
import { reserveEvidence, minimalEnvironment } from "../scripts/spikes/volume-isolation.mjs";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const profile = JSON.parse(await readFile("docker/desktop/seccomp_profile.json", "utf8"));

test("identities and registry reject traversal, owner ambiguity, duplicate IDs/UIDs and unknown state", () => {
  validateIds(OWNER, A);
  for (const value of ["../root", "ROOT", "a".repeat(36), `${A}/../${B}`, A.toUpperCase()]) assert.throws(() => validateIds(OWNER, value));
  const record = { ownerId: OWNER, agentId: A, uid: 20000, gid: 20000, name: "ec_20000", state: "ready" };
  validateRegistry({ version: 1, agents: [record] });
  for (const mutation of [{ uid: 0 }, { gid: 0 }, { name: "root" }, { state: "unknown" }, { extra: "field" }])
    assert.throws(() => validateRegistry({ version: 1, agents: [{ ...record, ...mutation }] }));
  assert.throws(() => validateRegistry({ version: 1, agents: [record, { ...record, agentId: B }] }));
  assert.throws(() => validateRegistry({ version: 1, agents: [record, { ...record, ownerId: OTHER, uid: 20001, gid: 20001, name: "ec_20001" }] }));
});

test("owner CLI refuses unsafe container and workspace identities", () => {
  const project = "eclipse011test";
  const value = { Config: { Labels: { "com.docker.compose.project": project, "com.docker.compose.service": "desktop" }, User: "0:0", Env: ["PATH=/bin"] },
    State: { Running: true, Health: { Status: "healthy" } }, HostConfig: { ReadonlyRootfs: true, CapDrop: ["ALL"], CapAdd: SETUP_CAPS,
      SecurityOpt: ["no-new-privileges:true", `seccomp=${JSON.stringify(profile)}`] }, NetworkSettings: { Ports: {} },
    Mounts: [{ Type: "volume", Name: `${project}_workspace`, Destination: "/workspace", RW: true }] };
  validateDesktopTarget(value, project, profile);
  for (const change of [(v) => { v.HostConfig.Privileged = true; }, (v) => { v.HostConfig.CapAdd = ["ALL"]; },
    (v) => { v.HostConfig.Init = true; }, (v) => { v.Mounts[0].Type = "bind"; },
    (v) => { v.Config.Env.push("MODEL_API_KEY=synthetic"); }, (v) => { v.Config.Labels["com.docker.compose.project"] = "main"; },
    (v) => { v.HostConfig.SecurityOpt = ["seccomp=unconfined"]; }]) {
    const changed = structuredClone(value); change(changed); assert.throws(() => validateDesktopTarget(changed, project, profile));
  }
  const volume = { Name: `${project}_workspace`, Driver: "local", Labels: { "com.docker.compose.project": project, "com.docker.compose.volume": "workspace" } };
  validateWorkspace(volume, project, volume.Name);
  for (const change of [{ Driver: "nfs" }, { Options: { device: "/host" } }, { Name: "main_workspace" }])
    assert.throws(() => validateWorkspace({ ...volume, ...change }, project, volume.Name));
});

test("help and invalid CLI arguments do not need Docker or expose the model environment", () => {
  const cli = path.resolve("scripts/desktop-agent.mjs"); const env = { ...minimalEnvironment(), MODEL_API_KEY: "CANARY_MODEL_KEY" };
  const help = spawnSync(process.execPath, [cli, "--help"], { env, encoding: "utf8" }); assert.equal(help.status, 0);
  const invalid = spawnSync(process.execPath, [cli, "exec", "--owner", OWNER, "--agent", "../root", "--", "true"], { env, encoding: "utf8" });
  assert.equal(invalid.status, 1); assert.ok(!(invalid.stdout + invalid.stderr).includes("CANARY_MODEL_KEY"));
});

test("real identities, capability drop, private files, noexec, concurrent provisioning and restart persistence", { timeout: 600000 }, async () => {
  const project = `eclipse011${randomBytes(8).toString("hex")}`;
  const evidence = await reserveEvidence(path.resolve("data/spikes/task-011"));
  const summary = { task: "TASK-011", runId: evidence.runId, outcome: "incomplete", phase: "build", checks: [], cleanup: "pending" };
  let dockerPath = "docker";
  if (process.platform === "win32") { try { await access("E:\\Apps\\Docker\\resources\\bin\\docker.exe"); dockerPath = "E:\\Apps\\Docker\\resources\\bin\\docker.exe"; } catch { /* PATH fallback. */ } }
  const env = { ...minimalEnvironment(), DESKTOP_CONTROL_SECRET: randomBytes(32).toString("hex"), POSTGRES_BOOTSTRAP_PASSWORD: randomBytes(24).toString("hex"),
    POSTGRES_APP_PASSWORD: randomBytes(24).toString("hex"), POSTGRES_MIGRATOR_PASSWORD: randomBytes(24).toString("hex") };
  const empty = path.join(evidence.directory, "empty.env"); const override = path.join(evidence.directory, "override.json");
  await writeFile(empty, "", { flag: "wx", mode: 0o600 });
  await writeFile(override, JSON.stringify({ services: { desktop: { labels: { "ai.eclipse.task011.run": project }, build: { labels: { "ai.eclipse.task011.run": project } } } } }), { flag: "wx", mode: 0o600 });
  const prefix = ["compose", "--env-file", empty, "--project-name", project, "--file", path.resolve("docker-compose.yml"), "--file", override];
  const raw = (args, options = {}) => spawnSync(dockerPath, args, { env, encoding: "utf8", windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024, ...options });
  const checked = (args, options) => {
    const result = raw(args, options);
    if (result.status !== 0) {
      const reason = /"reason":\s*"([a-z_]+)"/.exec(result.stderr ?? "")?.[1];
      const operation = /"operation":\s*"([a-z_]+)"/.exec(result.stderr ?? "")?.[1];
      if (reason) summary.operationFailure = { reason, ...(operation ? { operation } : {}) };
    }
    assert.equal(result.status, 0, `${summary.phase}: ${summary.operationFailure?.reason ?? "Docker operation failed"}${summary.phase === "isolation" ? String(result.stderr).slice(0, 3000) : ""}`); return result.stdout.trim();
  };
  const compose = (args, options) => checked([...prefix, ...args], options);
  let container; let built = false;
  const adminArgs = (command, agent = A, extra = [], owner = OWNER) => ["exec", "--user", "0:0", container, "python3", "/opt/eclipse/desktop/bootstrap.py", "--admin", command, owner, agent, ...extra];
  const admin = (command, agent, extra, owner) => checked(adminArgs(command, agent, extra, owner));
  const agentRun = (agent, code) => admin("exec", agent, ["node", "--input-type=module", "-e", code]);
  const fixture = (code) => checked(["exec", "--user", "0:0", container, "node", "--input-type=module", "-e", code]);
  const ready = async () => {
    for (let i = 0; i < 70; i++) {
      const state = checked(["inspect", "--format", "{{.State.Health.Status}}", container]);
      if (state === "healthy") return;
      if (checked(["inspect", "--format", "{{.State.Running}}", container]) !== "true") {
        // Only expose the fixed bootstrap reason, never arbitrary runtime logs.
        const logs = raw(["logs", container]).stderr ?? "";
        summary.bootstrapReason = /"reason":\s*"([a-z_]+)"/.exec(logs)?.[1] ?? "bootstrap_unavailable";
        assert.fail(summary.bootstrapReason);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.fail("desktop_not_healthy");
  };
  try {
    compose(["build", "desktop"], { timeout: 300000 }); built = true;
    compose(["up", "-d", "--no-build", "desktop"]); compose(["ps"]);
    container = compose(["ps", "-q", "desktop"]); summary.phase = "bootstrap"; await ready();
    const roles = JSON.parse(fixture("import fs from 'node:fs'; const fields=Object.fromEntries(fs.readFileSync('/proc/1/status','utf8').split(String.fromCharCode(10)).filter(l=>l.includes(':')).map(l=>[l.slice(0,l.indexOf(':')),l.slice(l.indexOf(':')+1).trim()])); console.log(JSON.stringify(fields));"));
    for (const name of ["CapEff", "CapPrm", "CapBnd"]) assert.equal(roles[name], "00000000000001c3");
    assert.equal(roles.NoNewPrivs, "1"); assert.ok(+roles.Seccomp_filters >= 2); summary.checks.push("supervisor_sys_admin_dropped_and_filter_inherited");
    checked(["exec", "--user", "0:0", container, "python3", "-c", "import sys,ctypes,errno;sys.path.insert(0,'/opt/eclipse/desktop');import bootstrap;bootstrap.reduce_privileges();libc=ctypes.CDLL(None,use_errno=True);assert libc.syscall(165,None,None,None,0,None)==-1 and ctypes.get_errno()==errno.EPERM;assert libc.syscall(0x40000027)==-1 and ctypes.get_errno()==errno.ENOSYS"]);
    summary.checks.push("reduced_admin_mount_and_x32_syscalls_denied");
    fixture("import fs from 'node:fs'; fs.writeFileSync('/workspace/unrelated-control','preserve');");
    summary.phase = "provision";
    const a = JSON.parse(admin("create", A)); const b = JSON.parse(admin("create", B));
    assert.notEqual(a.uid, b.uid); assert.equal(JSON.parse(admin("create", A)).uid, a.uid);
    assert.notEqual(raw(adminArgs("create", A, [], OTHER)).status, 0);
    assert.notEqual(raw(adminArgs("create", "../root")).status, 0);
    assert.notEqual(raw(adminArgs("inspect", C)).status, 0);
    const ownerCli = spawnSync(process.execPath, ["scripts/desktop-agent.mjs", "inspect", "--project", project, "--owner", OWNER, "--agent", A], { env: { ...env, PATH: path.dirname(dockerPath) + path.delimiter + (env.PATH ?? "") }, encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(ownerCli.status, 0, ownerCli.stderr); assert.equal(JSON.parse(ownerCli.stdout).uid, a.uid);
    summary.checks.push("stable_owner_scoped_identities", "verified_owner_cli");
    summary.phase = "isolation";
    for (const record of [a, b]) agentRun(record.agentId, "import fs from 'node:fs';fs.writeFileSync(process.env.HOME+'/work/marker','private-'+process.getuid());fs.writeFileSync(process.env.HOME+'/.config/chromium/profile.fixture','profile-'+process.getuid());");
    for (const [self, peer] of [[a, b], [b, a]]) {
      const result = JSON.parse(agentRun(self.agentId, `import assert from 'node:assert/strict';import fs from 'node:fs';import{spawnSync}from'node:child_process';
        const home=${JSON.stringify(self.home)},other=${JSON.stringify(peer.home)},uid=${self.uid};
        assert.equal(process.getuid(),uid); assert.equal(process.getgid(),uid); assert.equal(process.cwd(),home);
        assert.equal(spawnSync('id',['-un'],{encoding:'utf8'}).stdout.trim(),${JSON.stringify(self.name)});
        const fields=Object.fromEntries(fs.readFileSync('/proc/self/status','utf8').split(String.fromCharCode(10)).filter(l=>l.includes(':')).map(l=>[l.slice(0,l.indexOf(':')),l.slice(l.indexOf(':')+1).trim()]));for(const field of ['CapEff','CapPrm','CapBnd','CapInh','CapAmb'])assert.equal(BigInt('0x'+fields[field]),0n);assert.equal(fields.NoNewPrivs,'1');assert.equal(spawnSync('id',['-G'],{encoding:'utf8'}).stdout.trim(),String(uid));
        for(const suffix of ['', '/inbox','/outbox','/work','/.config/chromium','/Downloads']){const st=fs.statSync(home+suffix);assert.equal(st.uid,uid);assert.equal(st.mode&0o777,0o700);}
        fs.writeFileSync(home+'/work/marker','private-'+uid);fs.writeFileSync(home+'/.config/chromium/profile.fixture','profile-'+uid);
        for(const target of [other,other+'/work/marker','/workspace/.system/agents.json','/workspace/.system/downloads'])assert.throws(()=>fs.readdirSync(target),e=>e.code==='EACCES');
        assert.throws(()=>fs.writeFileSync(other+'/work/intruder','bad'),e=>e.code==='EACCES');
        fs.symlinkSync(other,home+'/work/peer-link');assert.throws(()=>fs.readFileSync(home+'/work/peer-link/work/marker'),e=>e.code==='EACCES');fs.unlinkSync(home+'/work/peer-link');
        assert.throws(()=>process.setuid(0),e=>e.code==='EPERM');assert.equal(spawnSync('sudo',['-n','true']).error.code,'ENOENT');
        const script=['#!/bin/sh','exit 0',''].join(String.fromCharCode(10));fs.writeFileSync(home+'/work/control',script,{mode:0o700});assert.equal(spawnSync(home+'/work/control').status,0);
        fs.writeFileSync(home+'/Downloads/control',script,{mode:0o700});assert.equal(spawnSync(home+'/Downloads/control').error.code,'EACCES');
        const unshare=spawnSync('unshare',['--user','--map-root-user','--mount','/bin/mount','-t','tmpfs','tmpfs','/tmp'],{encoding:'utf8'});assert.notEqual(unshare.status,0);assert.match(unshare.stderr,/Operation not permitted|permission denied/i);
        console.log(JSON.stringify({isolated:true,noexec:true,capabilitiesZero:true}));`));
      assert.deepEqual(result, { isolated: true, noexec: true, capabilitiesZero: true });
    }
    summary.checks.push("two_direction_file_uid_and_capability_denials", "downloads_direct_exec_denied_work_control_succeeds", "mount_denied_in_descendant_user_namespace");
    summary.phase = "concurrency";
    const { runProcess } = await import("../scripts/spikes/volume-isolation.mjs");
    const concurrent = await Promise.all([C, C].map((id) => runProcess(dockerPath, adminArgs("create", id), { env, timeout: 15000 })));
    assert.ok(concurrent.every((value) => value.status === 0)); assert.equal(JSON.parse(concurrent[0].output).uid, JSON.parse(concurrent[1].output).uid);
    const registry = fixture("import fs from 'node:fs'; console.log(fs.readFileSync('/workspace/.system/agents.json','utf8'));");
    fixture("import fs from 'node:fs'; fs.writeFileSync('/workspace/.system/agents.json','invalid');");
    assert.notEqual(raw(adminArgs("create", A)).status, 0);
    fixture(`import fs from 'node:fs'; fs.writeFileSync('/workspace/.system/agents.json',${JSON.stringify(registry)});`);
    fixture("import fs from 'node:fs'; fs.writeFileSync('/run/eclipse/agents.lock','',{mode:0o600,flag:'wx'});");
    assert.notEqual(raw(adminArgs("create", A)).status, 0);
    fixture("import fs from 'node:fs'; fs.unlinkSync('/run/eclipse/agents.lock');");
    summary.checks.push("concurrent_idempotency_corrupt_registry_and_stale_lock_refusal");
    summary.phase = "alias";
    agentRun(A, "import fs from 'node:fs'; fs.unlinkSync(process.env.HOME+'/Downloads');fs.symlinkSync('/tmp',process.env.HOME+'/Downloads');");
    assert.notEqual(raw(adminArgs("inspect", A)).status, 0);
    fixture(`import fs from 'node:fs';fs.unlinkSync(${JSON.stringify(a.home + "/Downloads")});fs.symlinkSync(${JSON.stringify(a.downloads)},${JSON.stringify(a.home + "/Downloads")});fs.lchownSync(${JSON.stringify(a.home + "/Downloads")},${a.uid},${a.gid});`);
    summary.checks.push("downloads_alias_substitution_refused");
    summary.phase = "recreate"; const original = container;
    compose(["up", "-d", "--no-build", "--force-recreate", "desktop"]); container = compose(["ps", "-q", "desktop"]); assert.notEqual(container, original); await ready();
    for (const record of [a, b]) {
      assert.equal(JSON.parse(admin("inspect", record.agentId)).uid, record.uid);
      agentRun(record.agentId, `import assert from 'node:assert/strict';import fs from 'node:fs';import{spawnSync}from'node:child_process';assert.equal(fs.readFileSync(process.env.HOME+'/work/marker','utf8'),'private-'+process.getuid());assert.equal(fs.readFileSync(process.env.HOME+'/.config/chromium/profile.fixture','utf8'),'profile-'+process.getuid());assert.equal(spawnSync(process.env.HOME+'/Downloads/control').error.code,'EACCES');`);
    }
    assert.equal(fixture("import fs from 'node:fs';console.log(fs.readFileSync('/workspace/unrelated-control','utf8'));"), "preserve");
    summary.checks.push("recreated_nss_uid_files_profiles_and_noexec_persist", "unrelated_volume_data_preserved");
    summary.outcome = "passed"; summary.phase = "complete";
  } catch (error) { summary.reason = summary.bootstrapReason ?? `failed_${summary.phase}`; throw error; }
  finally {
    try {
      for (const [kind, args] of [["container", ["ps", "-aq"]], ["network", ["network", "ls", "-q"]], ["volume", ["volume", "ls", "-q"]]]) {
        for (const id of checked([...args, "--filter", `label=com.docker.compose.project=${project}`]).split(/\r?\n/).filter(Boolean)) {
          const [value] = JSON.parse(checked([kind, "inspect", id]));
          assert.equal((kind === "container" ? value.Config.Labels : value.Labels)["com.docker.compose.project"], project);
          if (kind === "volume") { assert.equal(value.Driver, "local"); assert.equal(Object.keys(value.Options ?? {}).length, 0); }
        }
      }
      compose(["down", "--volumes", "--remove-orphans"]);
      if (built) {
        const tag = `${project}-desktop:latest`; const [image] = JSON.parse(checked(["image", "inspect", tag]));
        assert.ok(image.RepoTags.includes(tag)); assert.equal(image.Config.Labels["ai.eclipse.task011.run"], project); checked(["image", "rm", tag]);
      }
      summary.cleanup = "complete";
    } catch { summary.cleanup = "refused"; summary.outcome = "incomplete"; summary.remainingProject = project; }
    await writeFile(path.join(evidence.directory, "result.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(`TASK-011 evidence: data/spikes/task-011/${evidence.runId}/result.json`); assert.equal(summary.cleanup, "complete");
  }
});
