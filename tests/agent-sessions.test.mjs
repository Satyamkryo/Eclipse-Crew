import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { SessionManager, validateSessionRequest } from "../docker/desktop/session-manager.mjs";
import { sessionRecord, runtimePrefix } from "../docker/desktop/session-worker.mjs";
import { launchAgent } from "../docker/desktop/agent-store.mjs";
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
  validateSessionRequest({ command: "session-fixture-cookie", ownerId: OWNER, agentId: A });
  assert.throws(() => validateSessionRequest({ command: "session-fixture-cookie", ownerId: OWNER, agentId: A, fixture: "cookie" }));
});
test("worker fixture environment is allowlisted to ECLIPSE_FIXTURES=1", () => {
  const record = { ...identity(), home: `/workspace/homes/${A}` };
  for (const extraEnv of [{ PATH: "/tmp" }, { ECLIPSE_FIXTURES: "0" }, { ECLIPSE_FIXTURES: "1", LD_PRELOAD: "/tmp/x.so" }, { ECLIPSE_FIXTURES: "1", HOME: "/tmp" }, null, []])
    assert.throws(() => launchAgent(record, ["true"], { extraEnv, stdio: "ignore" }), (error) => error.code === "invalid_identity");
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
  const env = { ...minimalEnvironment(), DESKTOP_CONTROL_SECRET: randomBytes(32).toString("hex"), EGRESS_DESKTOP_SECRET: randomBytes(32).toString("hex"), POSTGRES_BOOTSTRAP_PASSWORD: randomBytes(24).toString("hex"), POSTGRES_APP_PASSWORD: randomBytes(24).toString("hex"), POSTGRES_MIGRATOR_PASSWORD: randomBytes(24).toString("hex") };
  const empty = path.join(evidence.directory, "empty.env"), override = path.join(evidence.directory, "override.json");
  await writeFile(empty, "", { flag: "wx", mode: 0o600 });
  await writeFile(override, JSON.stringify({ services: { desktop: { environment: { ECLIPSE_FIXTURES: "1" }, labels: { "ai.eclipse.task012.run": project }, build: { labels: { "ai.eclipse.task012.run": project } } } } }), { flag: "wx", mode: 0o600 });
  const prefix = ["compose", "--env-file", empty, "--project-name", project, "--file", path.resolve("docker-compose.yml"), "--file", override];
  const raw = (args, options = {}) => spawnSync(dockerPath, args, { env, encoding: "utf8", windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024, ...options });
  const checked = (args, options) => { const result = raw(args, options); assert.equal(result.status, 0, `${summary.phase}: ${String(result.stderr).slice(-4000)}`); return result.stdout.trim(); };
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
  // The cookie fixture runs inside each agent's network namespace, on that agent's own loopback.
  const startFixture = (id) => admin("session-fixture-cookie", id);
  const loopbackListener = () => root(`import net from 'node:net';const s=net.connect({host:'127.0.0.1',port:18765});s.setTimeout(1500,()=>{s.destroy();console.log('refused');});s.once('connect',()=>{s.destroy();console.log('reachable');});s.once('error',()=>console.log('refused'));`);
  const noAgentProcesses = (uid) => root(`import fs from 'node:fs';let alive=0;for(const pid of fs.readdirSync('/proc').filter(x=>/^[0-9]+$/.test(x))){try{const s=fs.readFileSync('/proc/'+pid+'/status','utf8');if(Number(/^Uid:\\s+(\\d+)/m.exec(s)?.[1])===${uid}&&!/^State:\\s+Z/m.test(s))alive++;}catch{}}console.log(alive);`);
  try {
    compose(["build", "desktop"], { timeout: 300000 }); built = true; compose(["up", "-d", "--no-build", "desktop"]); compose(["ps"]); container = compose(["ps", "-q", "desktop"]); await ready();
    summary.phase = "provision";
    const a = JSON.parse(admin("create", A)), b = JSON.parse(admin("create", B));
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
    // Start A's fixture first: the container's own loopback must still have no listener, so the
    // server really lives in A's namespace, and B's namespace gets a separate one below.
    startFixture(A);
    assert.equal(loopbackListener(), "refused");
    startFixture(B);
    summary.checks.push("cookie_fixture_only_inside_each_agent_namespace");
    summary.phase = "windows";
    navigate(A, sa.display, "http://127.0.0.1:18765/seed?value=A"); navigate(B, sb.display, "http://127.0.0.1:18765/seed?value=B");
    await wait(() => title(A, sa.display).includes("Fixture A Cookie fixture=A") && title(B, sb.display).includes("Fixture B Cookie fixture=B"));
    summary.checks.push("independent_real_windows_synthetic_cookies_and_localstorage");
    // Each agent sees only its own persistent and session cookie values, never the peer's.
    const seeded = { A: title(A, sa.display), B: title(B, sb.display) };
    assert.ok(seeded.A.includes("sess=A") && !seeded.A.includes("=B"), `agent A cookies: ${seeded.A}`);
    assert.ok(seeded.B.includes("sess=B") && !seeded.B.includes("=A"), `agent B cookies: ${seeded.B}`);
    summary.checks.push("agent_windows_show_only_own_persistent_and_session_cookies");
    summary.phase = "denials";
    for (const [self, peer, display, peerDisplay] of [[a, b, sa.display, sb.display], [b, a, sb.display, sa.display]]) {
      agent(self.agentId, sessionEnv(self.agentId, display) + `
        assert.equal(fs.statSync(env.XAUTHORITY).mode&0o777,0o600);assert.equal(fs.statSync(runtime).mode&0o777,0o700);
        assert.throws(()=>fs.readdirSync(${JSON.stringify(peer.home + "/.config/chromium")}),e=>e.code==='EACCES');
        const denied=spawnSync('xdpyinfo',[],{env:{...env,DISPLAY:':${peerDisplay}'},stdio:'ignore',timeout:1000});assert.notEqual(denied.status,0);
        assert.notEqual(spawnSync('xdpyinfo',[],{env:{...env,XAUTHORITY:runtime+'/absent'},stdio:'ignore',timeout:1000}).status,0);
        const net=await import('node:net');await assert.rejects(new Promise((resolve,reject)=>{const s=net.connect('/run/eclipse/sessions.sock');s.setTimeout(1000,()=>{s.destroy();reject(Error('timeout'));});s.once('connect',()=>{s.destroy();resolve();});s.once('error',reject);}),e=>e.code==='EACCES');`);
    }
    // The peer's real cookie database cannot be read or opened by the other agent's Linux user.
    for (const [self, peer] of [[a, b], [b, a]]) {
      agent(self.agentId, `import fs from 'node:fs';import assert from 'node:assert/strict';for(const file of ['Default/Cookies','Default/Network/Cookies','Default/Login Data'])assert.throws(()=>fs.readFileSync(${JSON.stringify(peer.home + "/.config/chromium/")}+file),e=>e.code==='EACCES');`);
    }
    summary.checks.push("peer_cookie_and_login_database_paths_denied_to_other_agent_user");
    root(`import fs from 'node:fs';import assert from 'node:assert/strict';let workers=0,browsers=0;const outer=fs.readFileSync('/proc/1/uid_map','utf8').match(/[0-9]+/g).map(Number);for(const pid of fs.readdirSync('/proc').filter(n=>/^[0-9]+$/.test(n))){let s,c;try{s=fs.readFileSync('/proc/'+pid+'/status','utf8');c=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split(String.fromCharCode(0));}catch{continue;}const fields=Object.fromEntries(s.split(String.fromCharCode(10)).filter(l=>l.includes(':')).map(l=>[l.slice(0,l.indexOf(':')),l.slice(l.indexOf(':')+1).trim()]));const uid=Number(fields.Uid.split(String.fromCharCode(9))[0]);if(![${a.uid},${b.uid}].includes(uid))continue;if(c.some(x=>x.endsWith('/session-worker.mjs')))workers++;if(c.includes('--remote-debugging-pipe'))browsers++;assert.ok(!c.join(' ').includes('--remote-debugging-port'));const map=fs.readFileSync('/proc/'+pid+'/uid_map','utf8').match(/[0-9]+/g).map(Number);const cap=f=>BigInt('0x'+fields[f]);if(JSON.stringify(map)===JSON.stringify(outer)){for(const f of ['CapEff','CapPrm','CapInh','CapBnd','CapAmb'])assert.equal(cap(f),0n);}else{assert.deepEqual(map,[uid,uid,1]);assert.equal(cap('CapInh'),0n);assert.equal(cap('CapAmb'),0n);if(c[0]==='/opt/chromium/chrome-linux/chrome'||c[0].startsWith('/opt/chromium/chrome-linux/chrome --type=')){assert.equal(cap('CapEff')&~0x200000n,0n);assert.equal(cap('CapPrm')&~0x200000n,0n);}else{for(const f of ['CapEff','CapPrm','CapBnd'])assert.equal(cap(f),0n);}}assert.equal(fields.NoNewPrivs,'1');}assert.equal(workers,2);assert.equal(browsers,2);`);
    summary.checks.push("peer_and_missing_xauthority_rejected_profiles_control_private_zero_capabilities_pipe_cdp");
    const workers = JSON.parse(root(`import fs from 'node:fs';const out=[];for(const p of fs.readdirSync('/proc').filter(n=>/^[0-9]+$/.test(n))){try{const c=fs.readFileSync('/proc/'+p+'/cmdline','utf8').split(String.fromCharCode(0));if(c[1]==='/opt/eclipse/desktop/session-worker.mjs')out.push({pid:Number(p),uid:fs.statSync('/proc/'+p).uid});}catch{}}console.log(JSON.stringify(out));`));
    for (const [self, peer] of [[a, b], [b, a]]) {
      const peerWorker = workers.find((w) => w.uid === peer.uid); assert.ok(peerWorker);
      agent(self.agentId, `import fs from 'node:fs';import assert from 'node:assert/strict';assert.throws(()=>fs.openSync('/proc/${peerWorker.pid}/fd/3','w'),e=>['EACCES','EPERM'].includes(e.code));`);
    }
    root(`import fs from 'node:fs';import assert from 'node:assert/strict';for(const name of ['tcp','tcp6'])for(const line of fs.readFileSync('/proc/net/'+name,'utf8').trim().split(String.fromCharCode(10)).slice(1)){const fields=line.trim().split(/ +/);if(fields[3]==='0A')assert.ok(![${sa.display + 6000},${sb.display + 6000},9222].includes(parseInt(fields[1].split(':')[1],16)));}`);
    summary.checks.push("peer_worker_ipc_fd_access_denied_no_x11_or_cdp_tcp_listener");
    summary.phase = "host_and_secret_isolation";
    // Start the real database in the disposable stack so "cannot reach it" is a meaningful result.
    compose(["up", "-d", "--no-build", "--wait", "postgres"], { timeout: 180000 });
    const databaseId = compose(["ps", "-q", "postgres"]);
    const databaseIp = checked(["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", databaseId]).trim().split(/\s+/)[0];
    assert.match(databaseIp, /^\d+\.\d+\.\d+\.\d+$/, "database container has a network address");
    const mounts = JSON.parse(checked(["inspect", "--format", "{{json .Mounts}}", container]));
    assert.deepEqual(mounts.map((mount) => [mount.Type, mount.Destination]), [["volume", "/workspace"]], "desktop mounts only its own workspace volume");
    assert.equal(root("import{spawnSync}from'node:child_process';const r=spawnSync('find',['/','-path','/proc','-prune','-o','-path','/sys','-prune','-o','-name','.env*','-print'],{encoding:'utf8',timeout:60000});console.log(r.stdout.trim());"), "", "no .env file exists anywhere in the desktop filesystem");
    for (const self of [a, b]) {
      agent(self.agentId, `import fs from 'node:fs';import net from 'node:net';import dns from 'node:dns/promises';import{spawnSync}from'node:child_process';import assert from 'node:assert/strict';
        assert.notEqual(process.getuid(),0);
        for(const argv of [['sudo','-n','true'],['su','-c','true','root']])assert.notEqual(spawnSync(argv[0],argv.slice(1),{input:String.fromCharCode(10),timeout:3000}).status,0);
        assert.deepEqual(Object.keys(process.env).filter(n=>/SECRET|PASSWORD|DATABASE|ENCRYPTION|API_KEY|TOKEN/i.test(n)),[]);
        assert.throws(()=>fs.readFileSync('/proc/1/environ'),e=>['EACCES','EPERM'].includes(e.code));
        const tcp=(host,port)=>new Promise((resolve,reject)=>{const s=net.connect({host,port});s.setTimeout(2500,()=>{s.destroy();reject(Error('timeout'));});s.once('connect',()=>{s.destroy();resolve();});s.once('error',reject);});
        // Each exec gets a fresh namespace; the real browser reaching its own fixture is asserted above.
        await assert.rejects(tcp(${JSON.stringify(databaseIp)},5432));
        await assert.rejects(dns.lookup('postgres'));
        await assert.rejects(tcp('1.1.1.1',443));`);
    }
    summary.checks.push("desktop_has_only_own_volume_no_env_file_and_agent_users_have_no_sudo_secrets_database_or_internet");
    summary.phase = "session_cookies";
    const profileDirectory = `${a.home}/.config/chromium`;
    const snapshot = `${profileDirectory}/eclipse-session-cookies.json`;
    navigate(A, sa.display, "http://127.0.0.1:18765/late?value=A"); await wait(() => title(A, sa.display).includes("late=A"));
    navigate(A, sa.display, "http://127.0.0.1:18765/drop"); await wait(() => !title(A, sa.display).includes("gone="));
    summary.phase = "stop";
    assert.equal(JSON.parse(admin("session-stop", A)).state, "stopped"); assert.equal(JSON.parse(admin("session-stop", A)).state, "stopped");
    assert.equal(noAgentProcesses(a.uid), "0"); assert.equal(JSON.parse(admin("session-status", B)).state, "running"); assert.ok(title(B, sb.display).includes("Fixture B"));
    // The graceful stop wrote a private snapshot of exactly the live session cookies; the deleted one is absent.
    agent(A, `import fs from 'node:fs';import assert from 'node:assert/strict';const f=${JSON.stringify(snapshot)};const s=fs.lstatSync(f);assert.ok(s.isFile());assert.equal(s.uid,process.getuid());assert.equal(s.mode&0o777,0o600);const body=JSON.parse(fs.readFileSync(f,'utf8'));assert.equal(body.cookies.map(c=>c.name).sort().join(),'late,sess');assert.deepEqual(fs.readdirSync(${JSON.stringify(profileDirectory)}).filter(n=>n.startsWith('.eclipse-cookies')),[]);`);
    agent(B, `import fs from 'node:fs';import assert from 'node:assert/strict';assert.throws(()=>fs.readFileSync(${JSON.stringify(snapshot)}),e=>e.code==='EACCES');assert.throws(()=>fs.readdirSync(${JSON.stringify(profileDirectory)}),e=>e.code==='EACCES');`);
    summary.checks.push("session_cookie_snapshot_private_exact_and_unreadable_by_peer");
    admin("session-start", A); startFixture(A); navigate(A, sa.display, "http://127.0.0.1:18765/check"); await wait(() => title(A, sa.display).includes("Fixture A Cookie fixture=A"));
    const restarted = title(A, sa.display);
    assert.ok(restarted.includes("sess=A") && restarted.includes("late=A") && restarted.includes("fixture=A"), `cookies after session restart: ${restarted}`);
    assert.ok(!restarted.includes("gone="), `a cookie deleted before stop stays deleted: ${restarted}`);
    summary.checks.push("session_and_persistent_cookies_survive_stop_start_and_deleted_cookie_stays_deleted");
    summary.checks.push("graceful_stop_no_orphans_peer_survives_profile_reopens");
    summary.phase = "untrusted_snapshots";
    // A planted bad snapshot must never block the session or restore anything.
    const plant = (kind) => agent(A, `import fs from 'node:fs';const f=${JSON.stringify(snapshot)};try{fs.unlinkSync(f)}catch{};const valid=JSON.stringify({version:1,savedAt:new Date().toISOString(),cookies:[{name:'sess',value:'A',domain:'127.0.0.1',path:'/',httpOnly:false,secure:false,sameSite:'Strict'}]});const kind=${JSON.stringify(kind)};if(kind==='corrupt')fs.writeFileSync(f,'{not json',{mode:0o600});else if(kind==='oversized')fs.writeFileSync(f,'x'.repeat(1048577),{mode:0o600});else if(kind==='symlink'){const t=process.env.HOME+'/work/planted.json';fs.writeFileSync(t,valid,{mode:0o600});fs.symlinkSync(t,f);}else{fs.writeFileSync(f,valid,{mode:0o644});fs.chmodSync(f,0o644);}`);
    for (const kind of ["corrupt", "oversized", "symlink", "loose_mode"]) {
      admin("session-stop", A); plant(kind);
      assert.equal(JSON.parse(admin("session-start", A)).state, "running", `session starts with a ${kind} snapshot`);
      startFixture(A); navigate(A, sa.display, "http://127.0.0.1:18765/check"); await wait(() => title(A, sa.display).includes("Fixture A Cookie fixture=A"));
      assert.ok(!title(A, sa.display).includes("sess="), `${kind} snapshot must not be restored: ${title(A, sa.display)}`);
    }
    const snapshotHas = (name) => agent(A, `import fs from 'node:fs';try{const f=${JSON.stringify(snapshot)};const b=JSON.parse(fs.readFileSync(f,'utf8'));console.log((fs.statSync(f).mode&0o777)===0o600&&b.cookies.some(c=>c.name===${JSON.stringify(name)}));}catch{console.log(false)}`).trim() === "true";
    const waitForSnapshot = async (name) => {
      for (let i = 0; i < 60 && !snapshotHas(name); i++) await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.ok(snapshotHas(name), `the periodic save wrote the ${name} session cookie within the save interval`);
    };
    agent(A, `import fs from 'node:fs';try{fs.unlinkSync(${JSON.stringify(snapshot)})}catch{}`); // drop the last planted file so only a real save can satisfy the wait below
    navigate(A, sa.display, "http://127.0.0.1:18765/seed?value=A"); await wait(() => title(A, sa.display).includes("sess=A"));
    await waitForSnapshot("sess");
    summary.checks.push("corrupt_oversized_symlinked_and_loose_mode_snapshots_ignored_without_blocking_start");
    summary.phase = "component_crash";
    agent(A, "import fs from 'node:fs';for(const p of fs.readdirSync('/proc').filter(n=>/^[0-9]+$/.test(n))){try{if(fs.readFileSync('/proc/'+p+'/comm','utf8').trim()==='Xvfb'&&fs.statSync('/proc/'+p).uid===process.getuid())process.kill(Number(p),'SIGKILL');}catch{}}");
    await wait(() => JSON.parse(admin("session-status", A)).state === "failed"); admin("session-stop", A); assert.equal(noAgentProcesses(a.uid), "0");
    assert.equal(JSON.parse(admin("session-status", B)).state, "running");
    const snapshotState = () => agent(A, `import fs from 'node:fs';try{const b=JSON.parse(fs.readFileSync(${JSON.stringify(snapshot)},'utf8'));console.log('snapshot:'+b.cookies.map(c=>c.name).join('+')+' mode:'+(fs.statSync(${JSON.stringify(snapshot)}).mode&0o777).toString(8));}catch(e){console.log('snapshot:'+e.code)}`).trim();
    const beforeRestart = snapshotState(); admin("session-start", A); startFixture(A);
    navigate(A, sa.display, "http://127.0.0.1:18765/check"); await wait(() => title(A, sa.display).includes("Fixture A Cookie fixture=A"));
    const afterDisplayCrash = title(A, sa.display);
    assert.ok(afterDisplayCrash.includes("sess=A"), `a crashed display must not erase the saved session cookies (${beforeRestart}; after restart ${snapshotState()}): ${afterDisplayCrash}`);
    summary.checks.push("component_failure_cleanup_and_independent_peer_lifecycle");
    summary.phase = "worker_crash";
    // A new cookie must reach disk through the 30 s periodic save alone, because the worker is then killed with no chance to close.
    navigate(A, sa.display, "http://127.0.0.1:18765/crash?value=A"); await wait(() => title(A, sa.display).includes("crashc=A"));
    await waitForSnapshot("crashc");
    agent(A, "import fs from 'node:fs';for(const p of fs.readdirSync('/proc').filter(n=>/^[0-9]+$/.test(n))){try{const c=fs.readFileSync('/proc/'+p+'/cmdline','utf8').split(String.fromCharCode(0));if(fs.statSync('/proc/'+p).uid===process.getuid()&&c[1]==='/opt/eclipse/desktop/session-worker.mjs')process.kill(Number(p),'SIGKILL');}catch{}}");
    await wait(() => JSON.parse(admin("session-status", A)).state === "failed"); admin("session-stop", A); assert.equal(noAgentProcesses(a.uid), "0");
    agent(A, "import fs from 'node:fs';import assert from 'node:assert/strict';assert.equal(fs.readdirSync('/tmp').filter(n=>n.startsWith('ec-'+process.getuid()+'-')).length,0);");
    assert.equal(JSON.parse(admin("session-status", B)).state, "running"); admin("session-start", A); startFixture(A);
    navigate(A, sa.display, "http://127.0.0.1:18765/check"); await wait(() => title(A, sa.display).includes("Fixture A Cookie fixture=A"));
    const afterKill = title(A, sa.display);
    assert.ok(afterKill.includes("sess=A") && afterKill.includes("crashc=A"), `session cookies after a killed worker: ${afterKill}`);
    summary.checks.push("session_cookies_survive_killed_worker_through_periodic_save");
    summary.checks.push("killed_worker_same_uid_fallback_reaps_children_and_private_runtime");
    summary.phase = "recreate"; const original = container;
    compose(["up", "-d", "--no-build", "--force-recreate", "desktop"]); container = compose(["ps", "-q", "desktop"]); assert.notEqual(container, original); await ready();
    for (const [id, value, display] of [[A, "A", sa.display], [B, "B", sb.display]]) {
      assert.equal(JSON.parse(admin("session-status", id)).state, "stopped"); admin("session-start", id); startFixture(id); navigate(id, display, "http://127.0.0.1:18765/check");
      await wait(() => title(id, display).includes(`Fixture ${value} Cookie fixture=${value}`));
      const afterRecreate = title(id, display);
      assert.ok(afterRecreate.includes(`sess=${value}`), `session cookie after container recreation (${value}): ${afterRecreate}`);
      if (value === "A") assert.ok(afterRecreate.includes("crashc=A"), `second session cookie after container recreation: ${afterRecreate}`);
      admin("session-stop", id);
    }
    summary.checks.push("session_cookies_survive_container_recreation");
    assert.equal(noAgentProcesses(a.uid), "0"); assert.equal(noAgentProcesses(b.uid), "0");
    assert.equal(root("import fs from 'node:fs';console.log(fs.readFileSync('/workspace/unrelated-control','utf8'));"), "keep");
    summary.checks.push("container_recreation_preserves_private_cookie_storage_and_unrelated_data");
    summary.phase = "module_sandbox";
    const record = JSON.stringify(identity(A, a.uid));
    const sandbox = JSON.parse(agent(A, `import assert from 'node:assert/strict';import{startSession,dispatchOperation}from'/opt/eclipse/desktop/session-worker.mjs';const s=await startSession(${record});try{const page=s.context.pages()[0];await page.goto('chrome://sandbox');const text=(await page.locator('body').innerText()).split(String.fromCharCode(9)).join(' ').split(String.fromCharCode(10)).join(' ');assert.match(text,/Layer 1 Sandbox +Namespace/);for(const label of ['PID namespaces','Network namespaces','Seccomp-BPF sandbox'])assert.match(text,new RegExp(label+' +Yes'));await page.goto('about:blank');await page.setContent('<input id="normal"><input id="password" type="password"><input id="otp" autocomplete="one-time-code">');await page.bringToFront();for(const selector of ['#password','#otp']){await assert.rejects(dispatchOperation(s,'browser.locator',{selector,action:'fill',text:'blocked'}),e=>e.code==='sensitive_target');await page.locator(selector).focus();await assert.rejects(dispatchOperation(s,'input.type',{text:'blocked'}),e=>e.code==='sensitive_target');assert.equal(await page.locator(selector).inputValue(),'');}await page.evaluate(()=>{const host=document.createElement('div');document.body.append(host);const closed=host.attachShadow({mode:'closed'});const input=document.createElement('input');input.type='password';closed.append(input);input.focus();});for(const[operation,params]of[['input.type',{text:'blocked'}],['input.key',{key:'Enter'}]])await assert.rejects(dispatchOperation(s,operation,params),e=>e.code==='sensitive_target');await page.evaluate(()=>{const outerHost=document.createElement('div');document.body.append(outerHost);const outer=outerHost.attachShadow({mode:'closed'});const innerHost=document.createElement('div');outer.append(innerHost);const inner=innerHost.attachShadow({mode:'closed'});const input=document.createElement('input');input.type='password';inner.append(input);input.focus();});for(const[operation,params]of[['input.type',{text:'blocked'}],['input.key',{key:'Enter'}]])await assert.rejects(dispatchOperation(s,operation,params),e=>e.code==='sensitive_target');await page.locator('#normal').focus();await dispatchOperation(s,'input.type',{text:'DesktopTyping42'});assert.equal(await page.locator('#normal').inputValue(),'DesktopTyping42');await page.locator('#normal').fill('');const maximumText='x'.repeat(4096);const typingStarted=Date.now();await dispatchOperation(s,'input.type',{text:maximumText}).catch(e=>{throw Error('max_type_'+e.code)});assert.ok(Date.now()-typingStarted<4000,'schema-maximum text completes within OPERATION_TIMEOUT_MS');assert.equal(await page.locator('#normal').inputValue(),maximumText);const full=await dispatchOperation(s,'capture.screenshot').catch(e=>{throw Error('screenshot_'+e.code)});assert.equal(full.width,1024);assert.equal(full.height,768);const crop=await dispatchOperation(s,'capture.screenshot',{crop:{x:10,y:15,width:80,height:60}}).catch(e=>{throw Error('crop_'+e.code)});assert.equal(crop.width,80);assert.equal(crop.height,60);const pages=await dispatchOperation(s,'browser.pages');assert.equal(pages.source_tag,'tool');assert.equal(pages.untrusted,true);console.log(JSON.stringify({namespace:true,seccomp:true}));}catch(e){console.error('SANDBOX_FAIL:'+(e?.code||e?.message));process.exitCode=1;}finally{await s.close();}`));
    assert.deepEqual(sandbox, { namespace: true, seccomp: true }); summary.checks.push("real_per_agent_sandbox_desktop_capture_crop_typing_and_sensitive_target_denials");
    const ownerSensitiveInput = JSON.parse(agent(A, `import assert from 'node:assert/strict';import{startSession,dispatchOperation}from'/opt/eclipse/desktop/session-worker.mjs';const s=await startSession(${record});try{const page=s.context.pages()[0];await page.goto('about:blank');await page.setContent('<input id="password" type="password">');await page.bringToFront();await page.locator('#password').focus();await assert.rejects(dispatchOperation(s,'input.type',{text:'agent-denied'}),e=>e.code==='sensitive_target');assert.equal(await page.locator('#password').inputValue(),'');await dispatchOperation(s,'input.type',{text:'OwnerSynthetic42'},true);assert.equal(await page.locator('#password').inputValue(),'OwnerSynthetic42');await dispatchOperation(s,'input.key',{key:'Enter'},true);assert.equal(await page.locator('#password').inputValue(),'OwnerSynthetic42');console.log(JSON.stringify({ownerSensitiveInput:true}));}finally{await s.close();}`));
    assert.deepEqual(ownerSensitiveInput, { ownerSensitiveInput: true }); summary.checks.push("trusted_owner_type_and_key_input_allowed_on_synthetic_sensitive_target");
    summary.phase = "page_snapshot";
    // Real Chromium: the snapshot lists only visible, unobstructed, non-secret controls, and the point it implies lands on the control
    // wherever the window sits on the screen and however the page is scrolled.
    const fixtureHtml = '<!doctype html><body style="margin:0;height:4000px">' +
      '<button style="position:absolute;left:100px;top:100px;width:120px;height:40px" onclick="document.title=\'saved\'">Save</button>' +
      '<a href="#" style="position:absolute;left:300px;top:100px;display:block;width:100px;height:30px" onclick="document.title=\'draft\';return false">Save draft</a>' +
      '<button style="position:absolute;left:100px;top:200px;width:120px;height:40px" onclick="document.title=\'covered\'">Covered</button>' +
      '<div style="position:absolute;left:90px;top:190px;width:140px;height:60px;background:#ddd"></div>' +
      '<button style="position:absolute;left:100px;top:2000px;width:120px;height:40px" onclick="document.title=\'below\'">Far below</button>' +
      '<input type="password" aria-label="Account password" style="position:absolute;left:100px;top:300px">' +
      '<input autocomplete="one-time-code" aria-label="Sign in code" style="position:absolute;left:300px;top:300px">' +
      '<input aria-label="Email address" value="private@example.com" style="position:absolute;left:100px;top:340px">' +
      '<a href="#" style="position:absolute;left:100px;top:380px;display:block;width:150px;height:24px">Forgot password?</a>' +
      '<iframe srcdoc="<button>Inner</button>" style="position:absolute;left:100px;top:430px;width:200px;height:60px"></iframe></body>';
    const snapshotCheck = JSON.parse(agent(A, `import assert from 'node:assert/strict';import{spawnSync}from'node:child_process';import{startSession,dispatchOperation}from'/opt/eclipse/desktop/session-worker.mjs';
      const s=await startSession(${record});const pause=(ms)=>new Promise((r)=>setTimeout(r,ms));
      try{const page=s.context.pages()[0];await page.goto('about:blank');await page.setContent(${JSON.stringify(fixtureHtml)});await page.bringToFront();await pause(300);
        let readCount=0;const read=async()=>{readCount++;const r=await dispatchOperation(s,'page.snapshot').catch(e=>{throw Error('snapshot_'+readCount+'_'+e.code);});assert.equal(r.source_tag,'tool');assert.equal(r.untrusted,true);return r;};
        const names=(r)=>r.elements.map((e)=>e.name);
        const clickNamed=async(r,name,expected)=>{const e=r.elements.find((x)=>x.name===name);assert.ok(e,'listed: '+name);await page.evaluate(()=>{document.title='none';});
          await dispatchOperation(s,'input.click',{button:'left',x:e.x+Math.floor(e.width/2),y:e.y+Math.floor(e.height/2)});await pause(250);assert.equal(await page.title(),expected,'click on '+name);return e;};
        const first=await read();
        assert.deepEqual(names(first).sort(),['Email address','Forgot password?','Save','Save draft']);
        assert.equal(first.frames,1);assert.ok(first.elements.every((e,i)=>e.ref===i+1));
        assert.ok(!JSON.stringify(first).includes('private@example.com'),'no field value in the snapshot');
        const verify=async(kind,value)=>dispatchOperation(s,'page.verify',{predicate:{kind,value}}).catch(e=>{throw Error('verify_'+kind+'_'+value+'_'+e.code);});
        assert.equal((await verify('control_present','Save')).status,'pass');
        assert.equal((await verify('control_present','Missing')).status,'fail');
        for(const name of ['Covered','Far below','Account password','Sign in code','Inner']) assert.equal((await verify('control_present',name)).status,'fail',name+' excluded');
        assert.equal((await verify('control_absent','Missing')).status,'pass');
        await page.locator('input[aria-label="Email address"]').focus();
        const focused=await read();assert.equal(focused.elements.find(e=>e.name==='Email address').focused,true);
        assert.ok(!JSON.stringify(focused).includes('private@example.com'));
        await page.locator('input[type="password"]').focus();
        assert.ok(!(await read()).elements.some(e=>e.focused),'sensitive focus not exposed');
        await page.evaluate(()=>{const duplicate=document.createElement('button');duplicate.textContent='Save';duplicate.style.cssText='position:absolute;left:500px;top:100px;width:100px;height:30px';duplicate.id='verify-duplicate';document.body.append(duplicate);});
        assert.equal((await verify('control_present','Save')).status,'unknown');
        await page.locator('#verify-duplicate').evaluate(el=>el.remove());

        const save=await clickNamed(first,'Save','saved');await clickNamed(first,'Save draft','draft');
        const origin={x:save.x-100,y:save.y-100};
        const moved=spawnSync('xdotool',['getactivewindow','windowmove','61','37'],{env:s.env,encoding:'utf8',timeout:3000});assert.equal(moved.status,0,'window moved: '+moved.stderr);await pause(500);
        const second=await read();const save2=second.elements.find((e)=>e.name==='Save');assert.ok(save2);
        assert.notDeepEqual({x:save2.x-100,y:save2.y-100},origin,'the window really moved');
        await clickNamed(second,'Save','saved');
        await page.evaluate(()=>window.scrollTo(0,1900));await pause(300);
        const third=await read();assert.ok(names(third).includes('Far below'));assert.ok(!names(third).includes('Save'));
        await clickNamed(third,'Far below','below');
        await page.evaluate(()=>window.scrollTo(0,0));
        await page.evaluate(()=>{const lots=document.createElement('div');for(let i=0;i<200;i++){const b=document.createElement('button');b.textContent='Item '+i;b.style.cssText='position:absolute;left:'+(500+(i%4)*120)+'px;top:'+(10+Math.floor(i/4)*14)+'px;width:100px;height:12px';lots.append(b);}document.body.append(lots);});
        const capped=await read();assert.ok(capped.elements.length<=150);
        console.log(JSON.stringify({listed:names(first).length,origin,movedOrigin:{x:save2.x-100,y:save2.y-100},capped:capped.elements.length}));
      }finally{await s.close();}`));
    assert.ok(snapshotCheck.listed === 4 && snapshotCheck.capped <= 150, JSON.stringify(snapshotCheck)); summary.checks.push("page_snapshot_lists_only_visible_unobstructed_non_secret_controls_and_clicks_land_at_any_window_position_and_scroll_with_closed_postconditions_and_focus");
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
