import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { SessionManager, validateSessionRequest } from "../docker/desktop/session-manager.mjs";
import { sessionRecord, runtimePrefix } from "../docker/desktop/session-worker.mjs";
import { minimalEnvironment, reserveEvidence, runProcess } from "../scripts/spikes/volume-isolation.mjs";

const OWNER = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const identity = (agentId = A, uid = 20000) => ({ ownerId: OWNER, agentId, uid, gid: uid, name: `ec_${uid}`, state: "ready" });

test("session identities and closed IPC schema reject caller-selected paths, flags and invalid IDs", () => {
  assert.equal(sessionRecord(identity()).display, 100);
  assert.ok(Buffer.byteLength(runtimePrefix(59999) + "abcdef/org.chromium.Chromium.abcdef/SingletonSocket") < 108);
  assert.throws(() => runtimePrefix(0));
  validateSessionRequest({ command: "session-start", ownerId: OWNER, agentId: A });
  for (const record of [{ ...identity(), uid: 0 }, { ...identity(), state: "pending" }, { ...identity(), home: "/root" }, { ...identity(), agentId: "../root" }]) assert.throws(() => sessionRecord(record));
  for (const request of [{ command: "exec", ownerId: OWNER, agentId: A }, { command: "session-start", ownerId: OWNER, agentId: A, args: ["--no-sandbox"] }, { command: "session-stop", ownerId: OWNER, agentId: "../root" }]) assert.throws(() => validateSessionRequest(request));
});
test("session lifecycle serializes the same agent and recovers its queue after refusal", async () => {
  const manager = new SessionManager(); const calls = [];
  const first = manager.serialize(A, async () => { await new Promise((resolve) => setTimeout(resolve, 10)); calls.push(1); throw Error("fixture"); });
  const second = manager.serialize(A, async () => { calls.push(2); return "ready"; });
  await assert.rejects(first); assert.equal(await second, "ready"); assert.deepEqual(calls, [1, 2]);
});
test("cleanup shares in-flight work, retries rejection, and keeps success cached", async () => {
  const manager = new SessionManager();
  const entry = { record: identity(), child: { stdin: null, exitCode: 0, signalCode: null }, tracked: new Map(), runtimeReady: Promise.resolve() };
  manager.observe = async () => {};
  let attempts = 0, rejectFirst;
  manager.terminate = async () => {
    attempts++;
    if (attempts === 1) await new Promise((_resolve, reject) => { rejectFirst = reject; });
  };
  const first = manager.clean(entry), concurrent = manager.clean(entry);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1);
  rejectFirst(Error("termination failed"));
  await assert.rejects(first, /termination failed/);
  await assert.rejects(concurrent, /termination failed/);
  assert.equal(entry.cleanup, null);
  await manager.clean(entry);
  await manager.clean(entry);
  assert.equal(attempts, 2);
});
test("session runtime retains pinned sandbox transport and rejects network debugging or access-control bypasses", async () => {
  const source = await readFile("docker/desktop/session-worker.mjs", "utf8");
  assert.match(source, /chromiumSandbox: true/); assert.match(source, /launchPersistentContext/);
  assert.match(source, /"-nolisten", "tcp"/); assert.match(source, /"-auth", authority/);
  assert.doesNotMatch(source, /--no-sandbox|--remote-debugging-port|xhost|"-ac"/);
});

test("two real graphical agent sessions isolate displays/profiles and survive lifecycle/recreation", { timeout: 900000 }, async () => {
  const project = `eclipse012${randomBytes(8).toString("hex")}`; const evidence = await reserveEvidence(path.resolve("data/spikes/task-012"));
  const summary = { task: "TASK-012", runId: evidence.runId, outcome: "incomplete", phase: "build", checks: [], cleanup: "pending" };
  let dockerPath = "docker"; if (process.platform === "win32") { try { await access("E:\\Apps\\Docker\\resources\\bin\\docker.exe"); dockerPath = "E:\\Apps\\Docker\\resources\\bin\\docker.exe"; } catch { /* PATH fallback. */ } }
  const env = { ...minimalEnvironment(), DESKTOP_CONTROL_SECRET: randomBytes(32).toString("hex"), POSTGRES_BOOTSTRAP_PASSWORD: randomBytes(24).toString("hex"), POSTGRES_APP_PASSWORD: randomBytes(24).toString("hex"), POSTGRES_MIGRATOR_PASSWORD: randomBytes(24).toString("hex") };
  const empty = path.join(evidence.directory, "empty.env"), override = path.join(evidence.directory, "override.json");
  await writeFile(empty, "", { flag: "wx", mode: 0o600 });
  await writeFile(override, JSON.stringify({ services: { desktop: { labels: { "ai.eclipse.task012.run": project }, build: { labels: { "ai.eclipse.task012.run": project } } } } }), { flag: "wx", mode: 0o600 });
  const prefix = ["compose", "--env-file", empty, "--project-name", project, "--file", path.resolve("docker-compose.yml"), "--file", override];
  const raw = (args, options = {}) => spawnSync(dockerPath, args, { env, encoding: "utf8", windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024, ...options });
  const checked = (args, options) => { const result = raw(args, options); assert.equal(result.status, 0, `${summary.phase}: ${String(result.stderr).slice(0, 2000)}`); return result.stdout.trim(); };
  const compose = (args, options) => checked([...prefix, ...args], options); let container, built = false;
  const args = (command, id = A, extra = [], owner = OWNER) => ["exec", "--user", "0:0", container, "python3", "/opt/eclipse/desktop/bootstrap.py", "--admin", command, owner, id, ...extra];
  const admin = (command, id, extra, owner) => checked(args(command, id, extra, owner));
  const agent = (id, code) => admin("exec", id, ["node", "--input-type=module", "-e", code]);
  const root = (code) => checked(["exec", "--user", "0:0", container, "node", "--input-type=module", "-e", code]);
  const wait = async (probe) => { for (let i = 0; i < 70; i++) { if (probe()) return; await new Promise((resolve) => setTimeout(resolve, 200)); } assert.fail(`timeout_${summary.phase}`); };
  const ready = () => wait(() => checked(["inspect", "--format", "{{.State.Health.Status}}", container]) === "healthy");
  const sessionEnv = (id, display) => `import fs from 'node:fs';import assert from 'node:assert/strict';import{spawnSync}from'node:child_process';
    const runtime=fs.readdirSync('/tmp').filter(n=>n.startsWith('ec-${display + 19900}-')).map(n=>'/tmp/'+n).find(n=>{try{return fs.lstatSync(n).uid===process.getuid()&&spawnSync('xdpyinfo',[],{env:{PATH:process.env.PATH,DISPLAY:':${display}',XAUTHORITY:n+'/Xauthority'},stdio:'ignore',timeout:1000}).status===0;}catch{return false;}});assert.ok(runtime);
    const env={PATH:process.env.PATH,HOME:process.env.HOME,DISPLAY:':${display}',XAUTHORITY:runtime+'/Xauthority'};
    const cmd=(a)=>{const r=spawnSync('xdotool',a,{env,encoding:'utf8',timeout:2000});assert.equal(r.status,0);return r.stdout.trim();};`;
  const navigate = (id, display, url) => agent(id, sessionEnv(id, display) + `cmd(['key','--clearmodifiers','ctrl+l']);cmd(['type','--clearmodifiers','--delay','1','--',${JSON.stringify(url)}]);cmd(['key','Return']);`);
  const title = (id, display) => agent(id, sessionEnv(id, display) + "console.log(cmd(['getactivewindow','getwindowname']));");
  const fixtureServer = () => checked(["exec", "-d", "--user", "0:0", container, "node", "--input-type=module", "-e",
    "import http from 'node:http';http.createServer((req,res)=>{const u=new URL(req.url,'http://127.0.0.1');const v=u.searchParams.get('value');res.setHeader('Content-Type','text/html');res.end('<!doctype html><script>'+ (u.pathname==='/seed'&&['A','B'].includes(v)?'localStorage.setItem(\"fixture\",'+JSON.stringify(v)+');document.cookie=\"fixture='+v+'; Max-Age=3600; SameSite=Strict\";':'') +'document.title=\"Fixture \"+localStorage.getItem(\"fixture\")+\" Cookie \"+document.cookie;</script>');}).listen(18765,'127.0.0.1');"]);
  const noAgentProcesses = (uid) => root(`import fs from 'node:fs';let alive=0;for(const pid of fs.readdirSync('/proc').filter(x=>/^[0-9]+$/.test(x))){try{const s=fs.readFileSync('/proc/'+pid+'/status','utf8');if(Number(/^Uid:\\s+(\\d+)/m.exec(s)?.[1])===${uid}&&!/^State:\\s+Z/m.test(s))alive++;}catch{}}console.log(alive);`);
  try {
    compose(["build", "desktop"], { timeout: 300000 }); built = true; compose(["up", "-d", "--no-build", "desktop"]); compose(["ps"]); container = compose(["ps", "-q", "desktop"]); await ready();
    summary.phase = "provision";
    const a = JSON.parse(admin("create", A)), b = JSON.parse(admin("create", B)); fixtureServer();
    root("import fs from 'node:fs';fs.writeFileSync('/workspace/unrelated-control','keep');");
    summary.phase = "conflicts";
    agent(A, "import fs from 'node:fs';fs.writeFileSync('/tmp/.X100-lock','1',{flag:'wx',mode:0o600});");
    assert.notEqual(raw(args("session-start", A)).status, 0);
    agent(A, "import fs from 'node:fs';import assert from 'node:assert/strict';assert.equal(fs.readFileSync('/tmp/.X100-lock','utf8'),'1');fs.unlinkSync('/tmp/.X100-lock');fs.symlinkSync((await import('node:os')).hostname()+'-1',process.env.HOME+'/.config/chromium/SingletonLock');");
    assert.notEqual(raw(args("session-start", A)).status, 0);
    agent(A, "import fs from 'node:fs';import assert from 'node:assert/strict';const p=process.env.HOME+'/.config/chromium/SingletonLock';assert.ok(fs.lstatSync(p).isSymbolicLink());fs.unlinkSync(p);");
    summary.checks.push("conflicting_display_and_busy_profile_refused_without_removal");
    summary.phase = "start";
    const started = await Promise.all([A, B].map((id) => runProcess(dockerPath, args("session-start", id), { env, timeout: 45000 })));
    for (let i = 0; i < started.length; i++) {
      if (started[i].status !== 0) {
        summary.startFailure = JSON.parse(admin("session-status", [A, B][i])).reason ?? "unknown";
      }
      assert.equal(started[i].status, 0, summary.startFailure ?? started[i].output);
    }
    const sa = JSON.parse(started[0].output), sb = JSON.parse(started[1].output);
    assert.equal(sa.state, "running"); assert.equal(sb.state, "running"); assert.notEqual(sa.display, sb.display);
    assert.deepEqual(JSON.parse(admin("session-start", A)), sa);
    assert.notEqual(raw(args("session-start", A, [], OTHER)).status, 0);
    const cli = spawnSync(process.execPath, ["scripts/desktop-agent.mjs", "session-status", "--project", project, "--owner", OWNER, "--agent", A], { env: { ...env, PATH: path.dirname(dockerPath) + path.delimiter + (env.PATH ?? "") }, encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).state, "running");
    summary.checks.push("two_concurrent_graphical_sessions_idempotent_owner_cli");
    summary.phase = "windows";
    navigate(A, sa.display, "http://127.0.0.1:18765/seed?value=A"); navigate(B, sb.display, "http://127.0.0.1:18765/seed?value=B");
    await wait(() => title(A, sa.display).includes("Fixture A Cookie fixture=A") && title(B, sb.display).includes("Fixture B Cookie fixture=B"));
    summary.checks.push("independent_real_windows_synthetic_cookies_and_localstorage");
    summary.phase = "denials";
    for (const [self, peer, display, peerDisplay] of [[a, b, sa.display, sb.display], [b, a, sb.display, sa.display]]) {
      agent(self.agentId, sessionEnv(self.agentId, display) + `
        assert.equal(fs.statSync(env.XAUTHORITY).mode&0o777,0o600);assert.equal(fs.statSync(runtime).mode&0o777,0o700);
        assert.throws(()=>fs.readdirSync(${JSON.stringify(peer.home + "/.config/chromium")}),e=>e.code==='EACCES');
        const denied=spawnSync('xdpyinfo',[],{env:{...env,DISPLAY:':${peerDisplay}'},stdio:'ignore',timeout:1000});assert.notEqual(denied.status,0);
        assert.notEqual(spawnSync('xdpyinfo',[],{env:{...env,XAUTHORITY:runtime+'/absent'},stdio:'ignore',timeout:1000}).status,0);
        const net=await import('node:net');await assert.rejects(new Promise((resolve,reject)=>{const s=net.connect('/run/eclipse/sessions.sock');s.setTimeout(1000,()=>{s.destroy();reject(Error('timeout'));});s.once('connect',()=>{s.destroy();resolve();});s.once('error',reject);}),e=>e.code==='EACCES');`);
    }
    root(`import fs from 'node:fs';import assert from 'node:assert/strict';let workers=0,browsers=0;const outer=fs.readFileSync('/proc/1/uid_map','utf8').match(/[0-9]+/g).map(Number);for(const pid of fs.readdirSync('/proc').filter(n=>/^[0-9]+$/.test(n))){let s,c;try{s=fs.readFileSync('/proc/'+pid+'/status','utf8');c=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split(String.fromCharCode(0));}catch{continue;}const fields=Object.fromEntries(s.split(String.fromCharCode(10)).filter(l=>l.includes(':')).map(l=>[l.slice(0,l.indexOf(':')),l.slice(l.indexOf(':')+1).trim()]));const uid=Number(fields.Uid.split(String.fromCharCode(9))[0]);if(![${a.uid},${b.uid}].includes(uid))continue;if(c.some(x=>x.endsWith('/session-worker.mjs')))workers++;if(c.includes('--remote-debugging-pipe'))browsers++;assert.ok(!c.join(' ').includes('--remote-debugging-port'));const map=fs.readFileSync('/proc/'+pid+'/uid_map','utf8').match(/[0-9]+/g).map(Number);const cap=f=>BigInt('0x'+fields[f]);if(JSON.stringify(map)===JSON.stringify(outer)){for(const f of ['CapEff','CapPrm','CapInh','CapBnd','CapAmb'])assert.equal(cap(f),0n);}else{assert.ok(c[0]==='/opt/chromium/chrome-linux/chrome'||c[0].startsWith('/opt/chromium/chrome-linux/chrome --type='));assert.deepEqual(map,[uid,uid,1]);assert.equal(cap('CapInh'),0n);assert.equal(cap('CapAmb'),0n);assert.equal(cap('CapEff')&~0x200000n,0n);assert.equal(cap('CapPrm')&~0x200000n,0n);}assert.equal(fields.NoNewPrivs,'1');}assert.equal(workers,2);assert.equal(browsers,2);`);
    summary.checks.push("peer_and_missing_xauthority_rejected_profiles_control_private_zero_capabilities_pipe_cdp");
    const workers = JSON.parse(root(`import fs from 'node:fs';const out=[];for(const p of fs.readdirSync('/proc').filter(n=>/^[0-9]+$/.test(n))){try{const c=fs.readFileSync('/proc/'+p+'/cmdline','utf8').split(String.fromCharCode(0));if(c[1]==='/opt/eclipse/desktop/session-worker.mjs')out.push({pid:Number(p),uid:fs.statSync('/proc/'+p).uid});}catch{}}console.log(JSON.stringify(out));`));
    for (const [self, peer] of [[a, b], [b, a]]) {
      const peerWorker = workers.find((w) => w.uid === peer.uid); assert.ok(peerWorker);
      agent(self.agentId, `import fs from 'node:fs';import assert from 'node:assert/strict';assert.throws(()=>fs.openSync('/proc/${peerWorker.pid}/fd/3','w'),e=>['EACCES','EPERM'].includes(e.code));`);
    }
    root(`import fs from 'node:fs';import assert from 'node:assert/strict';for(const name of ['tcp','tcp6'])for(const line of fs.readFileSync('/proc/net/'+name,'utf8').trim().split(String.fromCharCode(10)).slice(1)){const fields=line.trim().split(/ +/);if(fields[3]==='0A')assert.ok(![${sa.display + 6000},${sb.display + 6000},9222].includes(parseInt(fields[1].split(':')[1],16)));}`);
    summary.checks.push("peer_worker_ipc_fd_access_denied_no_x11_or_cdp_tcp_listener");
    summary.phase = "stop";
    assert.equal(JSON.parse(admin("session-stop", A)).state, "stopped"); assert.equal(JSON.parse(admin("session-stop", A)).state, "stopped");
    assert.equal(noAgentProcesses(a.uid), "0"); assert.equal(JSON.parse(admin("session-status", B)).state, "running"); assert.ok(title(B, sb.display).includes("Fixture B"));
    admin("session-start", A); navigate(A, sa.display, "http://127.0.0.1:18765/check"); await wait(() => title(A, sa.display).includes("Fixture A Cookie fixture=A"));
    summary.checks.push("graceful_stop_no_orphans_peer_survives_profile_reopens");
    summary.phase = "component_crash";
    agent(A, "import fs from 'node:fs';for(const p of fs.readdirSync('/proc').filter(n=>/^[0-9]+$/.test(n))){try{if(fs.readFileSync('/proc/'+p+'/comm','utf8').trim()==='Xvfb'&&fs.statSync('/proc/'+p).uid===process.getuid())process.kill(Number(p),'SIGKILL');}catch{}}");
    await wait(() => JSON.parse(admin("session-status", A)).state === "failed"); admin("session-stop", A); assert.equal(noAgentProcesses(a.uid), "0");
    assert.equal(JSON.parse(admin("session-status", B)).state, "running"); admin("session-start", A);
    summary.checks.push("component_failure_cleanup_and_independent_peer_lifecycle");
    summary.phase = "worker_crash";
    agent(A, "import fs from 'node:fs';for(const p of fs.readdirSync('/proc').filter(n=>/^[0-9]+$/.test(n))){try{const c=fs.readFileSync('/proc/'+p+'/cmdline','utf8').split(String.fromCharCode(0));if(fs.statSync('/proc/'+p).uid===process.getuid()&&c[1]==='/opt/eclipse/desktop/session-worker.mjs')process.kill(Number(p),'SIGKILL');}catch{}}");
    await wait(() => JSON.parse(admin("session-status", A)).state === "failed"); admin("session-stop", A); assert.equal(noAgentProcesses(a.uid), "0");
    agent(A, "import fs from 'node:fs';import assert from 'node:assert/strict';assert.equal(fs.readdirSync('/tmp').filter(n=>n.startsWith('ec-'+process.getuid()+'-')).length,0);");
    assert.equal(JSON.parse(admin("session-status", B)).state, "running"); admin("session-start", A);
    summary.checks.push("killed_worker_same_uid_fallback_reaps_children_and_private_runtime");
    summary.phase = "recreate"; const original = container;
    compose(["up", "-d", "--no-build", "--force-recreate", "desktop"]); container = compose(["ps", "-q", "desktop"]); assert.notEqual(container, original); await ready(); fixtureServer();
    for (const [id, value, display] of [[A, "A", sa.display], [B, "B", sb.display]]) {
      assert.equal(JSON.parse(admin("session-status", id)).state, "stopped"); admin("session-start", id); navigate(id, display, "http://127.0.0.1:18765/check");
      await wait(() => title(id, display).includes(`Fixture ${value} Cookie fixture=${value}`)); admin("session-stop", id);
    }
    assert.equal(noAgentProcesses(a.uid), "0"); assert.equal(noAgentProcesses(b.uid), "0");
    assert.equal(root("import fs from 'node:fs';console.log(fs.readFileSync('/workspace/unrelated-control','utf8'));"), "keep");
    summary.checks.push("container_recreation_preserves_private_cookie_storage_and_unrelated_data");
    summary.phase = "module_sandbox";
    const record = JSON.stringify(identity(A, a.uid));
    const sandbox = JSON.parse(agent(A, `import assert from 'node:assert/strict';import{startSession,dispatchOperation}from'/opt/eclipse/desktop/session-worker.mjs';const s=await startSession(${record});try{const page=s.context.pages()[0];await page.goto('chrome://sandbox');const text=(await page.locator('body').innerText()).split(String.fromCharCode(9)).join(' ').split(String.fromCharCode(10)).join(' ');assert.match(text,/Layer 1 Sandbox +Namespace/);for(const label of ['PID namespaces','Network namespaces','Seccomp-BPF sandbox'])assert.match(text,new RegExp(label+' +Yes'));await page.goto('about:blank');await page.setContent('<input id="normal"><input id="password" type="password"><input id="otp" autocomplete="one-time-code">');await page.bringToFront();for(const selector of ['#password','#otp']){await assert.rejects(dispatchOperation(s,'browser.locator',{selector,action:'fill',text:'blocked'}),e=>e.code==='sensitive_target');await page.locator(selector).focus();await assert.rejects(dispatchOperation(s,'input.type',{text:'blocked'}),e=>e.code==='sensitive_target');assert.equal(await page.locator(selector).inputValue(),'');}await page.evaluate(()=>{const host=document.createElement('div');document.body.append(host);const closed=host.attachShadow({mode:'closed'});const input=document.createElement('input');input.type='password';closed.append(input);input.focus();});for(const[operation,params]of[['input.type',{text:'blocked'}],['input.key',{key:'Enter'}]])await assert.rejects(dispatchOperation(s,operation,params),e=>e.code==='sensitive_target');await page.evaluate(()=>{const outerHost=document.createElement('div');document.body.append(outerHost);const outer=outerHost.attachShadow({mode:'closed'});const innerHost=document.createElement('div');outer.append(innerHost);const inner=innerHost.attachShadow({mode:'closed'});const input=document.createElement('input');input.type='password';inner.append(input);input.focus();});for(const[operation,params]of[['input.type',{text:'blocked'}],['input.key',{key:'Enter'}]])await assert.rejects(dispatchOperation(s,operation,params),e=>e.code==='sensitive_target');await page.locator('#normal').focus();await dispatchOperation(s,'input.type',{text:'DesktopTyping42'});assert.equal(await page.locator('#normal').inputValue(),'DesktopTyping42');const full=await dispatchOperation(s,'capture.screenshot');assert.equal(full.width,1024);assert.equal(full.height,768);const crop=await dispatchOperation(s,'capture.screenshot',{crop:{x:10,y:15,width:80,height:60}});assert.equal(crop.width,80);assert.equal(crop.height,60);const pages=await dispatchOperation(s,'browser.pages');assert.equal(pages.source_tag,'tool');assert.equal(pages.untrusted,true);console.log(JSON.stringify({namespace:true,seccomp:true}));}finally{await s.close();}`));
    assert.deepEqual(sandbox, { namespace: true, seccomp: true }); summary.checks.push("real_per_agent_sandbox_desktop_capture_crop_typing_and_sensitive_target_denials");
    summary.outcome = "passed"; summary.phase = "complete";
  } catch (error) { summary.reason = `failed_${summary.phase}`; throw error; }
  finally {
    try {
      for (const [kind, listing] of [["container", ["ps", "-aq"]], ["network", ["network", "ls", "-q"]], ["volume", ["volume", "ls", "-q"]]]) {
        for (const id of checked([...listing, "--filter", `label=com.docker.compose.project=${project}`]).split(/\r?\n/).filter(Boolean)) {
          const [value] = JSON.parse(checked([kind, "inspect", id])); assert.equal((kind === "container" ? value.Config.Labels : value.Labels)["com.docker.compose.project"], project);
          if (kind === "volume") { assert.equal(value.Driver, "local"); assert.equal(Object.keys(value.Options ?? {}).length, 0); }
        }
      }
      compose(["down", "--volumes", "--remove-orphans"]);
      if (built) { const tag = `${project}-desktop:latest`; const [image] = JSON.parse(checked(["image", "inspect", tag])); assert.ok(image.RepoTags.includes(tag)); assert.equal(image.Config.Labels["ai.eclipse.task012.run"], project); checked(["image", "rm", tag]); }
      summary.cleanup = "complete";
    } catch { summary.cleanup = "refused"; summary.outcome = "incomplete"; summary.remainingProject = project; }
    await writeFile(path.join(evidence.directory, "result.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(`TASK-012 evidence: data/spikes/task-012/${evidence.runId}/result.json`); assert.equal(summary.cleanup, "complete");
  }
});
