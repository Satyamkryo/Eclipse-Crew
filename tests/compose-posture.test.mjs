import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { minimalEnvironment } from "../scripts/spikes/volume-isolation.mjs";

const ADR_026_CAPS = ["CHOWN", "DAC_OVERRIDE", "SETUID", "SETGID", "SETPCAP", "SYS_ADMIN"];
const INTERNAL_NETWORKS = ["database", "desktop", "ingress_app", "egress_app"];
const OUTBOUND_NETWORKS = ["egress_out", "frontend"];
const DOCKER_SOCKET = /docker\.sock/;
const SYNTHETIC = {
  POSTGRES_BOOTSTRAP_PASSWORD: "bootstrap-" + "a".repeat(32),
  POSTGRES_APP_PASSWORD: "app-" + "b".repeat(32),
  POSTGRES_MIGRATOR_PASSWORD: "migrator-" + "c".repeat(32),
  DESKTOP_CONTROL_SECRET: "d".repeat(64),
  EGRESS_PROXY_SECRET: "e".repeat(64),
  EGRESS_DESKTOP_SECRET: "3".repeat(64),
  ENCRYPTION_KEY: "f".repeat(64),
  RECEIPT_SIGNING_KEY: "1".repeat(64),
  DATABASE_URL: `postgres://eclipse_app:${"2".repeat(32)}@postgres:5432/eclipse`,
};
const sorted = (values) => [...values].map(String).sort();
const serviceNames = (config) => sorted(Object.keys(config.services ?? {}));

async function dockerPath() {
  if (process.platform === "win32") {
    try { await access("E:\\Apps\\Docker\\resources\\bin\\docker.exe"); return "E:\\Apps\\Docker\\resources\\bin\\docker.exe"; }
    catch { /* PATH fallback. */ }
  }
  return "docker";
}

function run(docker, args, options = {}) {
  return spawnSync(docker, args, { env: { ...minimalEnvironment(), ...SYNTHETIC }, encoding: "utf8", windowsHide: true,
    timeout: 60000, maxBuffer: 16 * 1024 * 1024, ...options });
}

function mountLabel(volume) {
  return `${volume.type}:${volume.source ?? volume.target}`;
}

export function validatePosture(config) {
  assert.deepEqual(serviceNames(config), ["app", "desktop", "egress-proxy", "ingress", "postgres"], "unexpected service set");
  const services = config.services;
  const project = path.resolve(".");

  for (const [name, service] of Object.entries(services)) {
    if (name === "ingress") {
      assert.equal(service.ports?.length, 1, "ingress publishes exactly one port");
      assert.equal(service.ports[0].host_ip, "127.0.0.1", "ingress binds the host loopback only");
      assert.equal(String(service.ports[0].published), "3000", "ingress publishes port 3000");
      assert.equal(service.ports[0].target, 8080, "ingress forwards to port 8080");
      assert.equal(service.ports[0].protocol, "tcp", "ingress publishes TCP");
    } else {
      assert.ok(!service.ports?.length, `${name} publishes no port`);
    }
    assert.notEqual(service.privileged, true, `${name} is not privileged`);
    assert.notEqual(service.network_mode, "host", `${name} does not use the host network`);
    assert.notEqual(service.pid, "host", `${name} does not share the host PID namespace`);
    assert.notEqual(service.ipc, "host", `${name} does not share the host IPC namespace`);
    assert.ok(!service.devices?.length, `${name} mounts no host device`);
  }

  const named = {
    app: [["artifacts", "/var/eclipse/artifacts"]],
    desktop: [["workspace", "/workspace"]],
    "egress-proxy": [],
    postgres: [["postgres", "/var/lib/postgresql/data"]],
    ingress: [],
  };
  const binds = {
    postgres: [["db/provision.sql", "/opt/eclipse/provision.sql"]],
    ingress: [["docker/ingress.conf", "/etc/nginx/nginx.conf"]],
    app: [],
    desktop: [],
    "egress-proxy": [],
  };
  for (const [name, service] of Object.entries(services)) {
    const volumes = service.volumes ?? [];
    const expectedNamed = named[name] ?? [];
    const expectedBinds = (binds[name] ?? []).map(([source, target]) => [path.resolve(source), target]);
    const actualNamed = volumes.filter((volume) => volume.type === "volume").map((volume) => [volume.source, volume.target]);
    const actualBinds = volumes.filter((volume) => volume.type === "bind").map((volume) => [path.resolve(volume.source), volume.target]);
    assert.deepEqual(sorted(actualNamed.map((entry) => entry.join("->"))), sorted(expectedNamed.map((entry) => entry.join("->"))),
      `${mountLabel({ type: "volume", source: name })} mounts only its named volumes`);
    assert.deepEqual(sorted(actualBinds.map((entry) => entry.join("->"))), sorted(expectedBinds.map((entry) => entry.join("->"))),
      `${name} mounts only its read-only config bind`);
    for (const volume of volumes) {
      assert.ok(!DOCKER_SOCKET.test(volume.source ?? "") && !DOCKER_SOCKET.test(volume.target ?? ""), `${name} does not mount the Docker socket`);
      assert.ok(!(volume.source ?? "").split(/[\\/]/).includes(".env") && !/\.env(?:\.|$)/.test(path.basename(volume.source ?? "")), `${name} does not mount .env`);
      if (volume.type === "bind") {
        assert.equal(volume.read_only, true, `${name} config bind is read-only`);
        assert.notEqual(path.resolve(volume.source), project, `${name} does not mount the project directory`);
      }
    }
    if (name === "desktop") assert.ok((service.tmpfs ?? []).some((entry) => entry.startsWith("/tmp:")), "desktop has a /tmp tmpfs");
  }

  for (const name of INTERNAL_NETWORKS) assert.equal(config.networks?.[name]?.internal, true, `network ${name} is internal`);
  for (const name of OUTBOUND_NETWORKS) assert.notEqual(config.networks?.[name]?.internal, true, `network ${name} is not internal`);
  assert.deepEqual(sorted(Object.keys(services.desktop.networks ?? {})), ["desktop"], "desktop joins only the desktop network");
  assert.deepEqual(sorted(Object.keys(services.postgres.networks ?? {})), ["database"], "postgres joins only the database network");
  assert.deepEqual(sorted(Object.keys(services["egress-proxy"].networks ?? {})), ["desktop", "egress_app", "egress_out"], "egress-proxy joins its two internal networks and egress_out");
  assert.deepEqual(sorted(Object.keys(services.ingress.networks ?? {})), ["frontend", "ingress_app"], "ingress joins only its two networks");
  for (const [name, service] of Object.entries(services)) {
    for (const network of Object.keys(service.networks ?? {})) {
      if (OUTBOUND_NETWORKS.includes(network)) assert.ok(name === "egress-proxy" || name === "ingress", `${name} does not join ${network}`);
      else assert.ok(INTERNAL_NETWORKS.includes(network), `${name} joins only declared internal networks`);
    }
  }

  assert.deepEqual(sorted(services.desktop.cap_add ?? []), sorted(ADR_026_CAPS), "desktop adds exactly the six ADR-026 capabilities");
  for (const [name, service] of Object.entries(services)) {
    if (name !== "desktop") assert.ok(!service.cap_add?.length, `${name} adds no capabilities`);
    if (name === "postgres") continue;
    assert.ok((service.cap_drop ?? []).includes("ALL"), `${name} drops all capabilities`);
    assert.ok((service.security_opt ?? []).includes("no-new-privileges:true"), `${name} sets no-new-privileges`);
  }

  const withEnvironment = (key) => sorted(Object.entries(services).filter(([, service]) => Object.hasOwn(service.environment ?? {}, key)).map(([name]) => name));
  assert.deepEqual(withEnvironment("ENCRYPTION_KEY"), ["app"], "ENCRYPTION_KEY stays in app");
  assert.deepEqual(withEnvironment("RECEIPT_SIGNING_KEY"), ["app"], "RECEIPT_SIGNING_KEY stays in app");
  assert.deepEqual(withEnvironment("DATABASE_URL"), ["app"], "DATABASE_URL stays in app");
  assert.deepEqual(withEnvironment("EGRESS_PROXY_SECRET"), ["app", "egress-proxy"], "EGRESS_PROXY_SECRET stays in app and the proxy");
  assert.deepEqual(withEnvironment("EGRESS_DESKTOP_SECRET"), ["desktop", "egress-proxy"], "EGRESS_DESKTOP_SECRET stays in the desktop and the proxy");
  assert.deepEqual(withEnvironment("DESKTOP_CONTROL_SECRET"), ["app", "desktop"], "DESKTOP_CONTROL_SECRET stays in app and desktop");
  for (const key of ["POSTGRES_BOOTSTRAP_PASSWORD", "POSTGRES_APP_PASSWORD", "POSTGRES_MIGRATOR_PASSWORD"])
    assert.deepEqual(withEnvironment(key), [], `${key} is a Docker secret, never an environment value`);
  const desktopKeys = sorted(Object.keys(services.desktop.environment ?? {}));
  assert.ok(desktopKeys.every((key) => ["DESKTOP_CONTROL_SECRET", "EGRESS_DESKTOP_SECRET", "EGRESS_PROXY_URL"].includes(key)), "desktop receives no app secret");
  assert.ok(desktopKeys.includes("DESKTOP_CONTROL_SECRET"), "desktop receives its control secret");
  assert.deepEqual(sorted((services.postgres.secrets ?? []).map((secret) => secret.source)),
    ["postgres_app_password", "postgres_bootstrap_password", "postgres_migrator_password"], "postgres receives the three role secrets");
  const forbiddenOnDesktop = ["ENCRYPTION_KEY", "RECEIPT_SIGNING_KEY", "DATABASE_URL", "EGRESS_PROXY_SECRET"];
  for (const key of forbiddenOnDesktop) assert.ok(!Object.hasOwn(services.desktop.environment ?? {}, key), `desktop never receives ${key}`);
}

const docker = await dockerPath();
const available = run(docker, ["version", "--format", "{{.Server.Version}}"]).status === 0;
const noDocker = !available && "docker_unavailable";
const directory = await mkdtemp(path.join(tmpdir(), "eclipse048-posture-"));
const empty = path.join(directory, "empty.env");
await writeFile(empty, "", { flag: "wx", mode: 0o600 });
test.after(() => rm(directory, { recursive: true, force: true }));

function effectiveConfig(extra = []) {
  const result = run(docker, ["compose", "--env-file", empty, "--project-name", "eclipse048posture",
    "--file", path.resolve("docker-compose.yml"), ...extra, "config", "--format", "json"]);
  assert.equal(result.status, 0, `compose config: ${String(result.stderr).slice(0, 2000)}`);
  return JSON.parse(result.stdout);
}

test("effective Compose posture keeps ports, mounts, networks, capabilities and secrets scoped", { skip: noDocker }, async () => {
  validatePosture(effectiveConfig());
});

test("posture validation rejects a published port, socket mount, privileged desktop, wrong network, missing cap drop and leaked secret", { skip: noDocker }, async () => {
  const changes = [
    ["published_port", (config) => { config.services.app.ports = [{ host_ip: "0.0.0.0", target: 3000, published: "3000" }]; }],
    ["ingress_host_port", (config) => { config.services.ingress.ports[0].host_ip = "0.0.0.0"; }],
    ["docker_socket", (config) => { config.services.app.volumes.push({ type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock", read_only: true }); }],
    ["privileged", (config) => { config.services.desktop.privileged = true; }],
    ["network", (config) => { config.services.desktop.networks.frontend = null; }],
    ["cap_drop", (config) => { config.services.app.cap_drop = []; }],
    ["cap_add", (config) => { config.services.desktop.cap_add.push("SYS_PTRACE"); }],
    ["secret_scope", (config) => { config.services.desktop.environment.EGRESS_PROXY_SECRET = SYNTHETIC.EGRESS_PROXY_SECRET; }],
    ["desktop_secret_scope", (config) => { config.services.app.environment.EGRESS_DESKTOP_SECRET = SYNTHETIC.EGRESS_DESKTOP_SECRET; }],
    ["env_mount", (config) => { config.services.app.volumes.push({ type: "bind", source: path.resolve(".env"), target: "/app/.env", read_only: true }); }],
  ];
  for (const [name, mutate] of changes) {
    const config = effectiveConfig();
    mutate(config);
    assert.throws(() => validatePosture(config), (error) => error instanceof assert.AssertionError || typeof error.code === "string", `${name} must be rejected`);
  }
});

test("live containers run as their declared non-root identities", { skip: noDocker, timeout: 120000 }, async (t) => {
  const ids = {};
  for (const name of ["app", "postgres", "desktop", "egress-proxy", "ingress"]) {
    const result = run(docker, ["compose", "--env-file", empty, "ps", "-q", name]);
    ids[name] = result.status === 0 ? result.stdout.trim() : "";
  }
  if (Object.values(ids).some((id) => !id)) return t.skip("stack_not_running");
  for (const [name, id] of Object.entries(ids)) {
    const status = run(docker, ["inspect", "--format", "{{.State.Status}}", id]);
    assert.equal(status.status, 0, `${name} inspect`);
    assert.equal(status.stdout.trim(), "running", `${name} is running`);
  }
  const uid = (name) => {
    const result = run(docker, ["exec", ids[name], "id", "-u"]);
    assert.equal(result.status, 0, `${name} id -u: ${String(result.stderr).slice(0, 500)}`);
    return result.stdout.trim();
  };
  assert.notEqual(uid("app"), "0", "app does not run as root");
  assert.equal(uid("ingress"), "101", "ingress runs as 101");
  assert.equal(uid("egress-proxy"), "65534", "egress-proxy runs as 65534");
  const postgresUid = run(docker, ["exec", ids.postgres, "sh", "-c", "awk '/^Uid:/{print $2}' /proc/1/status"]);
  assert.equal(postgresUid.status, 0, `postgres status: ${String(postgresUid.stderr).slice(0, 500)}`);
  assert.notEqual(postgresUid.stdout.trim(), "0", "postgres server process is not root");
  const workers = run(docker, ["exec", "--user", "0:0", ids.desktop, "/usr/local/bin/node", "--input-type=module", "-e", `
    import fs from 'node:fs';
    const found = [];
    for (const pid of fs.readdirSync('/proc').filter((entry) => /^[0-9]+$/.test(entry))) {
      let cmdline, status;
      try { cmdline = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split(String.fromCharCode(0)); status = fs.readFileSync('/proc/' + pid + '/status', 'utf8'); } catch { continue; }
      if (!cmdline.includes('/opt/eclipse/desktop/session-worker.mjs') || cmdline.includes('--terminate')) continue;
      const field = (name) => new RegExp('^' + name + ':\\\\s+(\\\\S+)', 'm').exec(status)?.[1];
      found.push({ pid: +pid, uid: +field('Uid'), caps: ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].map((name) => field(name)), noNewPrivs: field('NoNewPrivs') });
    }
    console.log(JSON.stringify(found));`]);
  assert.equal(workers.status, 0, `desktop worker scan: ${String(workers.stderr).slice(0, 1000)}`);
  for (const worker of JSON.parse(workers.stdout)) {
    assert.ok(worker.uid >= 20000 && worker.uid <= 59999, `agent worker ${worker.pid} has an agent uid`);
    assert.ok(worker.caps.every((value) => value === "0000000000000000"), `agent worker ${worker.pid} has zero capability sets`);
    assert.equal(worker.noNewPrivs, "1", `agent worker ${worker.pid} sets no-new-privileges`);
  }
  t.diagnostic(`agent workers checked: ${JSON.parse(workers.stdout).length}`);
});
