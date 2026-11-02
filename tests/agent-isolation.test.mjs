import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { minimalEnvironment, reserveEvidence, runProcess } from "../scripts/spikes/volume-isolation.mjs";

const OWNER = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const hex = (bytes) => randomBytes(bytes).toString("hex");

test("agent A cannot reach agent B's processes, files, tmp state, VNC or control listeners", { timeout: 1800000 }, async () => {
  const project = `eclipse048${hex(8)}`;
  const evidence = await reserveEvidence(path.resolve("data/spikes/task-048"));
  const secrets = {
    DESKTOP_CONTROL_SECRET: hex(32),
    EGRESS_PROXY_SECRET: hex(32),
    ENCRYPTION_KEY: hex(32),
    RECEIPT_SIGNING_KEY: hex(32),
    POSTGRES_BOOTSTRAP_PASSWORD: hex(24),
    POSTGRES_APP_PASSWORD: hex(24),
    POSTGRES_MIGRATOR_PASSWORD: hex(24),
    DATABASE_URL: `postgres://eclipse_app:${hex(24)}@postgres:5432/eclipse`,
  };
  const summary = { task: "TASK-048", runId: evidence.runId, utc: new Date().toISOString(), outcome: "incomplete",
    phase: "build", checks: [], deferred: [], findings: [], cleanup: "pending" };
  let current = "build";
  let dockerPath = "docker"; let built = false; let container; let egress;
  if (process.platform === "win32") { try { await access("E:\\Apps\\Docker\\resources\\bin\\docker.exe"); dockerPath = "E:\\Apps\\Docker\\resources\\bin\\docker.exe"; } catch { /* PATH fallback. */ } }
  const env = { ...minimalEnvironment(), ...secrets };
  const empty = path.join(evidence.directory, "empty.env");
  const override = path.join(evidence.directory, "override.json");
  await writeFile(empty, "", { flag: "wx", mode: 0o600 });
  await writeFile(override, JSON.stringify({ services: {
    desktop: { labels: { "ai.eclipse.task048.run": project }, build: { labels: { "ai.eclipse.task048.run": project } },
      networks: { desktop: { aliases: ["app"] } } },
    "egress-proxy": { labels: { "ai.eclipse.task048.run": project }, build: { labels: { "ai.eclipse.task048.run": project } } },
  } }), { flag: "wx", mode: 0o600 });
  const prefix = ["compose", "--env-file", empty, "--project-name", project, "--file", path.resolve("docker-compose.yml"), "--file", override];
  const raw = (args, options = {}) => spawnSync(dockerPath, args, { env, encoding: "utf8", windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024, ...options });
  const checked = (args, options) => { const result = raw(args, options); assert.equal(result.status, 0, `${current}: ${String(result.stderr || result.stdout).slice(0, 2000)}`); return result.stdout.trim(); };
  const compose = (args, options) => checked([...prefix, ...args], options);
  const adminArgs = (command, id = A, extra = []) => ["exec", "--user", "0:0", container, "python3", "/opt/eclipse/desktop/bootstrap.py", "--admin", command, OWNER, id, ...extra];
  const admin = (command, id, extra) => checked(adminArgs(command, id, extra), { timeout: 60000 });
  const agent = (id, code) => admin("exec", id, ["node", "--input-type=module", "-e", code]);
  const agentPython = (id, code) => admin("exec", id, ["python3", "-c", code]);
  const root = (code) => checked(["exec", "--user", "0:0", container, "node", "--input-type=module", "-e", code]);
  const record = (name, detail) => summary.checks.push({ name, result: "passed", ...(detail === undefined ? {} : { detail }) });
  const wait = async (probe, label) => { for (let i = 0; i < 180; i++) { if (probe()) return; await new Promise((resolve) => setTimeout(resolve, 1000)); } assert.fail(`timeout_${label}`); };
  const ready = () => wait(() => checked(["inspect", "--format", "{{.State.Health.Status}}", container]) === "healthy", "desktop_health");

  try {
    compose(["build", "desktop", "egress-proxy"], { timeout: 1200000 }); built = true;
    compose(["up", "-d", "--no-build", "desktop", "egress-proxy"], { timeout: 180000 });
    container = compose(["ps", "-q", "desktop"]); egress = compose(["ps", "-q", "egress-proxy"]);
    assert.ok(container && egress, "two services started"); await ready();
    const egressIp = checked(["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", egress]).split(" ").filter(Boolean)[0];
    assert.ok(/^\d+\.\d+\.\d+\.\d+$/.test(egressIp), "egress proxy has a network address");

    current = "agents"; const a = JSON.parse(admin("create", A)); const b = JSON.parse(admin("create", B));
    assert.notEqual(a.uid, b.uid); assert.ok(a.uid >= 20000 && b.uid >= 20000);
    current = "sessions";
    const started = await Promise.all([A, B].map((id) => runProcess(dockerPath, adminArgs("session-start", id), { env, timeout: 60000 })));
    for (let index = 0; index < started.length; index++) {
      if (started[index].status !== 0) summary.startFailure = JSON.parse(admin("session-status", [A, B][index])).reason ?? "unknown";
      assert.equal(started[index].status, 0, `${summary.startFailure ?? started[index].output}`);
    }
    const sa = JSON.parse(started[0].output); const sb = JSON.parse(started[1].output);
    assert.equal(sa.state, "running"); assert.equal(sb.state, "running"); assert.notEqual(sa.display, sb.display);

    current = "loopback";
    for (const [self, _peer, peerSession] of [[a, b, sb], [b, a, sa]]) {
      const output = JSON.parse(agent(self.agentId, `
        import net from 'node:net';
        import http from 'node:http';
        import assert from 'node:assert/strict';
        const vnc = await new Promise((resolve, reject) => {
          const socket = net.connect({ host: '127.0.0.1', port: ${peerSession.vncPort} });
          let data = Buffer.alloc(0); let state = 'version'; let done = false;
          const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); if (error) reject(error); else resolve(value); };
          const timer = setTimeout(() => finish(Error('vnc_timeout')), 5000);
          socket.on('error', (error) => finish(error));
          socket.on('close', () => finish(Error('vnc_closed_before_result')));
          socket.on('data', (chunk) => {
            if (done) return;
            data = Buffer.concat([data, chunk]);
            try {
              if (state === 'version') {
                if (data.length < 12) return;
                assert.equal(data.subarray(0, 12).toString('ascii'), 'RFB 003.008' + String.fromCharCode(10), 'vnc_version');
                data = data.subarray(12); state = 'security'; socket.write('RFB 003.008' + String.fromCharCode(10));
              } else if (state === 'security') {
                if (!data.length || data.length < data[0] + 1) return;
                const count = data[0]; const types = [...data.subarray(1, count + 1)];
                assert.ok(types.includes(2), 'vnc_auth_offered'); assert.ok(!types.includes(1), 'vnc_none_not_offered');
                data = data.subarray(count + 1); state = 'challenge'; socket.write(Buffer.from([2]));
              } else if (state === 'challenge') {
                if (data.length < 16) return;
                data = data.subarray(16); state = 'result'; socket.write(Buffer.alloc(16));
              } else {
                if (data.length < 4) return;
                const result = data.readUInt32BE(0); assert.notEqual(result, 0, 'vnc_empty_password_refused');
                finish(null, result);
              }
            } catch (error) { finish(error); }
          });
        });
        const request = (port, headers) => new Promise((resolve, reject) => {
          const req = http.request({ host: '127.0.0.1', port, path: '/v1/agents/${A}/commands', method: 'POST',
            headers: { 'content-type': 'application/json', ...headers } }, (res) => {
            let body = ''; res.on('data', (chunk) => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body }));
          });
          req.setTimeout(4000, () => { req.destroy(); reject(Error('http_timeout')); }); req.on('error', reject); req.end('{}');
        });
        const without = await request(4310, {});
        const wrong = await request(4310, { authorization: 'Bearer ' + '${"0".repeat(64)}' });
        const files = await request(4311, {});
        const filesWrong = await request(4311, { authorization: 'Bearer ' + '${"0".repeat(64)}' });
        for (const result of [without, wrong, files, filesWrong]) { assert.equal(result.status, 403); assert.equal(JSON.parse(result.body).code, 'source_denied'); }
        console.log(JSON.stringify({ vnc: 'handshake_only_empty_password_refused', controlWithoutToken: 403, controlWrongToken: 403, files: 403, filesWrongToken: 403 }));
      `));
      record(`loopback_authenticated_not_unreachable_${self.agentId}`, { ...output, boundary: "authenticated_not_network_isolated" });
    }

    current = "proc";
    const findWorker = (executor, peerUid) => JSON.parse(agent(executor, `
      import fs from 'node:fs';
      const found = [];
      for (const entry of fs.readdirSync('/proc')) {
        if (!entry.split('').every((value) => value >= '0' && value <= '9')) continue;
        try {
          if (fs.statSync('/proc/' + entry).uid !== ${peerUid}) continue;
          const cmd = fs.readFileSync('/proc/' + entry + '/cmdline', 'utf8').split(String.fromCharCode(0));
          if (!cmd.includes('/opt/eclipse/desktop/session-worker.mjs') || cmd.includes('--terminate')) continue;
          found.push(+entry);
        } catch {}
      }
      console.log(JSON.stringify(found));
    `));
    for (const [self, peer, peerSession] of [[a, b, sb], [b, a, sa]]) {
      const [peerPid] = findWorker(self.agentId, peer.uid); assert.ok(peerPid, "peer session worker visible");
      const output = JSON.parse(agent(self.agentId, `
        import fs from 'node:fs';
        import assert from 'node:assert/strict';
        const pid = ${peerPid};
        const denied = (fn, label) => assert.throws(fn, (error) => ['EACCES', 'EPERM'].includes(error.code), label);
        denied(() => fs.readFileSync('/proc/' + pid + '/environ'), 'environ');
        denied(() => fs.readFileSync('/proc/' + pid + '/mem'), 'mem');
        denied(() => fs.readFileSync('/proc/' + pid + '/maps'), 'maps');
        denied(() => fs.readdirSync('/proc/' + pid + '/fd'), 'fd');
        denied(() => fs.readlinkSync('/proc/' + pid + '/cwd'), 'cwd');
        denied(() => fs.readlinkSync('/proc/' + pid + '/root'), 'root');
        denied(() => fs.readFileSync('/proc/1/environ'), 'init_environ');
        const rows = [];
        for (const entry of fs.readdirSync('/proc')) {
          if (!entry.split('').every((value) => value >= '0' && value <= '9')) continue;
          let cmd;
          try { cmd = fs.readFileSync('/proc/' + entry + '/cmdline', 'utf8').split(String.fromCharCode(0)).join(' ').trim(); } catch { continue; }
          if (cmd) rows.push({ pid: +entry, cmd });
        }
        console.log(JSON.stringify({ pid, denied: 7, rows }));
      `));
      const leaked = output.rows.filter(({ cmd }) => Object.values(secrets).some((value) => cmd.includes(value)));
      assert.deepEqual(leaked, [], `${self.agentId} sees a secret on a world-readable command line`);
      const vncRow = output.rows.find(({ cmd }) => cmd.includes('x11vnc') && cmd.includes(':' + peerSession.display));
      assert.ok(vncRow, "peer x11vnc command line is visible");
      assert.ok(vncRow.cmd.includes('-passwdfile'), "x11vnc reads its password from a file");
      const authFile = vncRow.cmd.split(' ').find((token) => token.startsWith('rm:/tmp/'));
      assert.ok(authFile, "x11vnc password file is removed after reading");
      const authStatus = root(`
        import fs from 'node:fs';
        try { fs.lstatSync(${JSON.stringify(authFile.slice(3))}); console.log('present'); }
        catch (error) { console.log(error.code); }
      `);
      assert.equal(authStatus, "ENOENT", "the VNC password file no longer exists");
      record(`proc_read_denials_and_cmdline_secret_scan_${self.agentId}`, { pid: output.pid, denied: output.denied, cmdlines: output.rows.length, leaked: 0, vncPasswordFile: "removed" });
    }

    current = "environment";
    for (const self of [a, b]) {
      const output = JSON.parse(agent(self.agentId, `
        import fs from 'node:fs';
        import assert from 'node:assert/strict';
        const forbidden = new Set(['DESKTOP_CONTROL_SECRET', 'EGRESS_DESKTOP_SECRET', 'EGRESS_PROXY_SECRET', 'ENCRYPTION_KEY', 'RECEIPT_SIGNING_KEY', 'DATABASE_URL']);
        const suspicious = (name) => forbidden.has(name) || ['SECRET', 'PASSWORD', 'TOKEN', 'ENCRYPTION', 'DATABASE'].some((part) => name.includes(part));
        assert.deepEqual(Object.keys(process.env).filter(suspicious), []);
        const offenders = [];
        for (const entry of fs.readdirSync('/proc')) {
          if (!entry.split('').every((value) => value >= '0' && value <= '9')) continue;
          let text;
          try { text = fs.readFileSync('/proc/' + entry + '/environ', 'utf8'); } catch { continue; }
          const names = text.split(String.fromCharCode(0)).map((row) => row.split('=')[0]).filter(suspicious);
          if (names.length) offenders.push({ pid: +entry, names });
        }
        assert.deepEqual(offenders, []);
        console.log(JSON.stringify({ own: Object.keys(process.env).sort(), readableOffenders: 0 }));
      `));
      record(`agent_environment_has_no_secrets_${self.agentId}`, output);
    }

    current = "process_control";
    for (const [self, peer] of [[a, b], [b, a]]) {
      const [peerPid] = findWorker(self.agentId, peer.uid); assert.ok(peerPid);
      const output = JSON.parse(agent(self.agentId, `
        import assert from 'node:assert/strict';
        const pid = ${peerPid};
        assert.throws(() => process.kill(pid, 0), (error) => error.code === 'EPERM');
        assert.throws(() => process.kill(pid, 'SIGTERM'), (error) => error.code === 'EPERM');
        console.log(JSON.stringify({ pid, signal0: 'EPERM', sigterm: 'EPERM' }));
      `));
      const ptrace = JSON.parse(agentPython(self.agentId, `
import ctypes, errno
libc = ctypes.CDLL(None, use_errno=True)
libc.ptrace.restype = ctypes.c_long
pid = ${peerPid}
ctypes.set_errno(0)
attached = libc.ptrace(16, pid, None, None)
attach_errno = ctypes.get_errno()
class IOVec(ctypes.Structure):
    _fields_ = [('base', ctypes.c_void_p), ('len', ctypes.c_size_t)]
buffer = ctypes.create_string_buffer(16)
local = IOVec(ctypes.cast(buffer, ctypes.c_void_p), 16)
remote = IOVec(ctypes.c_void_p(0x1000), 16)
libc.process_vm_readv.restype = ctypes.c_ssize_t
ctypes.set_errno(0)
read = libc.process_vm_readv(pid, ctypes.byref(local), 1, ctypes.byref(remote), 1, 0)
read_errno = ctypes.get_errno()
assert attached == -1 and attach_errno in (errno.EPERM, errno.EACCES), (attached, attach_errno)
assert read == -1 and read_errno in (errno.EPERM, errno.EACCES), (read, read_errno)
print('{"ptrace":"EPERM","process_vm_readv":"EPERM"}')
      `));
      assert.equal(JSON.parse(admin("session-status", peer.agentId)).state, "running", "peer survives the attempts");
      record(`process_control_denied_${self.agentId}`, { ...output, ...ptrace, peerAlive: true });
    }

    current = "tmp";
    for (const [self, peer, peerSession] of [[a, b, sb], [b, a, sa]]) {
      const output = JSON.parse(agent(self.agentId, `
        import fs from 'node:fs';
        import assert from 'node:assert/strict';
        const peerUid = ${peer.uid}; const display = ${peerSession.display};
        const runtime = fs.readdirSync('/tmp').filter((name) => name.startsWith('ec-' + peerUid + '-')).map((name) => '/tmp/' + name);
        assert.ok(runtime.length >= 1, 'peer runtime directory visible by name');
        for (const directory of runtime) {
          assert.equal(fs.statSync(directory).uid, peerUid); assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
          assert.throws(() => fs.readdirSync(directory), (error) => error.code === 'EACCES');
          assert.throws(() => fs.openSync(directory + '/Xauthority', 'r'), (error) => error.code === 'EACCES');
        }
        assert.equal(fs.statSync('/tmp').mode & 0o1000, 0o1000);
        assert.equal(fs.statSync('/tmp/.X11-unix').mode & 0o1000, 0o1000);
        const socket = '/tmp/.X11-unix/X' + display; const lock = '/tmp/.X' + display + '-lock';
        for (const target of [socket, lock]) {
          assert.equal(fs.statSync(target).uid, peerUid);
          assert.throws(() => fs.unlinkSync(target), (error) => ['EPERM', 'EACCES'].includes(error.code));
          assert.throws(() => fs.renameSync(target, target + '.moved'), (error) => ['EPERM', 'EACCES'].includes(error.code));
        }
        assert.throws(() => fs.writeFileSync(lock, 'x'), (error) => error.code === 'EACCES');
        console.log(JSON.stringify({ runtime: runtime.length, display, unlink: 'denied', rename: 'denied' }));
      `));
      record(`tmp_runtime_and_display_denied_${self.agentId}`, output);
    }
    assert.equal(JSON.parse(admin("session-stop", B)).state, "stopped");
    const lock = `/tmp/.X${sb.display}-lock`;
    agent(A, `import fs from 'node:fs'; import assert from 'node:assert/strict';
      assert.equal(fs.existsSync(${JSON.stringify(lock)}), false, 'the stopped session removed its display lock');`);
    agent(A, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(lock)}, '1', { flag: 'wx', mode: 0o600 });`);
    const refused = raw(adminArgs("session-start", B));
    let reason = ""; try { reason = JSON.parse(refused.stderr || refused.stdout).reason; } catch { /* asserted below */ }
    assert.notEqual(refused.status, 0, "a peer-created display lock refuses the start");
    assert.ok(reason, `structured refusal: ${String(refused.stderr).slice(0, 500)}`);
    const retained = agent(A, `import fs from 'node:fs'; const target = ${JSON.stringify(lock)};
      console.log(fs.existsSync(target) && fs.lstatSync(target).uid === process.getuid() && fs.readFileSync(target, 'utf8') === '1');`).trim();
    assert.equal(retained, "true", "the refused start does not remove the peer-created lock");
    if (reason !== "display_conflict") summary.findings.push({ name: "display_conflict_reason_masked", observed: reason,
      expected: "display_conflict", note: "the start is refused, but start() rethrows a cleanup error from the peer-owned lock" });
    agent(A, `import fs from 'node:fs'; import assert from 'node:assert/strict'; const target = ${JSON.stringify(lock)};
      const value = fs.lstatSync(target); assert.equal(value.uid, process.getuid()); assert.equal(fs.readFileSync(target, 'utf8'), '1');
      fs.unlinkSync(target);`);
    assert.equal(JSON.parse(admin("session-start", B)).state, "running");
    record("peer_precreated_display_lock_refused_without_removal", { lock: "owned_by_A_retained", reason, restarted: true });

    current = "files";
    for (const [self, peer] of [[a, b], [b, a]]) {
      agent(peer.agentId, `
        import fs from 'node:fs';
        for (const area of ['inbox', 'work', 'outbox']) fs.writeFileSync(process.env.HOME + '/' + area + '/private.txt', 'peer-private-' + area, { mode: 0o600 });
        fs.writeFileSync('/downloads/${peer.agentId}/private.txt', 'peer-private-downloads', { mode: 0o600 });
      `);
      const output = JSON.parse(agent(self.agentId, `
        import fs from 'node:fs';
        import assert from 'node:assert/strict';
        const peerHome = ${JSON.stringify(peer.home)};
        const peerDownloads = '/downloads/${peer.agentId}';
        const peerBacking = '/workspace/.system/downloads/${peer.agentId}';
        const denied = (fn, label) => assert.throws(fn, (error) => ['EACCES', 'EPERM'].includes(error.code), label);
        for (const directory of [peerHome, peerDownloads]) {
          denied(() => fs.readdirSync(directory), directory);
          assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
        }
        for (const directory of [peerHome + '/inbox', peerHome + '/work', peerHome + '/outbox']) {
          denied(() => fs.statSync(directory), directory);
          denied(() => fs.readdirSync(directory), directory);
        }
        denied(() => fs.statSync(peerBacking), 'peerBacking');
        denied(() => fs.readdirSync(peerBacking), 'peerBackingList');
        for (const file of [peerHome + '/inbox/private.txt', peerHome + '/work/private.txt', peerHome + '/outbox/private.txt', peerDownloads + '/private.txt', peerBacking + '/private.txt']) denied(() => fs.readFileSync(file), file);
        denied(() => fs.writeFileSync(peerHome + '/inbox/evil.txt', 'x'), 'homeWrite');
        denied(() => fs.writeFileSync(peerDownloads + '/evil.txt', 'x'), 'downloadsWrite');
        denied(() => fs.chmodSync(peerHome, 0o777), 'homeChmod');
        denied(() => fs.symlinkSync('/etc/passwd', peerHome + '/evil-link'), 'homeSymlink');
        const ownLink = process.env.HOME + '/peer-link';
        try { fs.unlinkSync(ownLink); } catch {}
        fs.symlinkSync(peerHome + '/inbox/private.txt', ownLink);
        denied(() => fs.readFileSync(ownLink), 'ownSymlink');
        denied(() => fs.readdirSync('/workspace/.system'), 'system');
        console.log(JSON.stringify({ peerHome, directories: 2, nestedDirectories: 3, files: 5, write: 'denied', chmod: 'denied', symlink: 'denied' }));
      `));
      record(`peer_files_unreadable_${self.agentId}`, output);
    }

    current = "network";
    for (const self of [a, b]) {
      const output = JSON.parse(agent(self.agentId, `
        import net from 'node:net';
        import dns from 'node:dns/promises';
        import fs from 'node:fs';
        import assert from 'node:assert/strict';
        const tcp = (host, port) => new Promise((resolve, reject) => {
          const socket = net.connect({ host, port });
          socket.setTimeout(2500, () => { socket.destroy(); reject(Error('timeout')); });
          socket.once('connect', () => { socket.destroy(); reject(Error('connected')); });
          socket.once('error', reject);
        });
        const denied = async (host, port) => { await assert.rejects(tcp(host, port), (error) => error.message !== 'connected', 'unexpected connection to ' + host + ':' + port); };
        await denied('1.1.1.1', 443);
        const rows = fs.readFileSync('/proc/net/route', 'utf8').trim().split(String.fromCharCode(10)).slice(1)
          .map((line) => line.trim().split(String.fromCharCode(9)).filter(Boolean)).filter((fields) => fields.length > 7);
        const connected = rows.find((fields) => fields[1] !== '00000000' && fields[7] !== '00000000');
        assert.ok(connected, 'connected subnet route');
        const octets = (value) => { const out = []; for (let index = 3; index >= 0; index--) out.push(parseInt(value.slice(index * 2, index * 2 + 2), 16)); return out; };
        const destination = octets(connected[1]); const mask = octets(connected[7]);
        const network = destination.map((value, index) => value & mask[index]); network[3] += 1;
        const gateway = network.join('.');
        await denied(gateway, 4320);
        await denied(gateway, 2375);
        await assert.rejects(dns.lookup('egress-proxy'));
        await denied('${egressIp}', 4320);
        console.log(JSON.stringify({ public: 'denied', gateway, gatewayPorts: [4320, 2375], proxyDns: 'denied', proxyIp: 'denied' }));
      `));
      record(`no_direct_egress_from_agent_user_${self.agentId}`, output);
    }
    summary.deferred.push({ name: "per_agent_proxy_tokens", reason: "TASK-045 is not implemented; the proxy still uses one shared secret with no desktop route" });
    summary.deferred.push({ name: "credential_store_isolation", reason: "no credential store exists yet (TASK-070)" });

    summary.outcome = "passed"; summary.phase = "complete";
  } catch (error) {
    summary.outcome = "incomplete"; summary.phase = current; summary.reason = `failed_${current}`;
    summary.checks.push({ name: current, result: "failed", error: String(error.message).slice(0, 2000) });
    throw error;
  } finally {
    try {
      for (const [kind, listing] of [["container", ["ps", "-aq"]], ["network", ["network", "ls", "-q"]], ["volume", ["volume", "ls", "-q"]]]) {
        for (const id of checked([...listing, "--filter", `label=com.docker.compose.project=${project}`]).split(/\r?\n/).filter(Boolean)) {
          const [value] = JSON.parse(checked([kind, "inspect", id]));
          const labels = kind === "container" ? value.Config.Labels : value.Labels;
          assert.equal(labels["com.docker.compose.project"], project);
          if (kind === "volume") { assert.equal(value.Driver, "local"); assert.equal(Object.keys(value.Options ?? {}).length, 0); }
        }
      }
      compose(["down", "--volumes", "--remove-orphans"]);
      if (built) {
        for (const tag of [`${project}-desktop:latest`, `${project}-egress-proxy:latest`]) {
          const [image] = JSON.parse(checked(["image", "inspect", tag]));
          assert.equal(image.Config.Labels["ai.eclipse.task048.run"], project);
          checked(["image", "rm", tag]);
        }
      }
      for (const [kind, listing] of [["container", ["ps", "-aq"]], ["network", ["network", "ls", "-q"]], ["volume", ["volume", "ls", "-q"]]])
        assert.equal(checked([...listing, "--filter", `label=com.docker.compose.project=${project}`]).trim(), "", `${kind} leftovers remain`);
      summary.cleanup = "complete";
    } catch {
      summary.cleanup = "refused"; summary.outcome = "incomplete"; summary.remainingProject = project;
    }
    await writeFile(path.join(evidence.directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(`TASK-048 evidence: data/spikes/task-048/${evidence.runId}/summary.json`);
    assert.equal(summary.cleanup, "complete");
  }
});
