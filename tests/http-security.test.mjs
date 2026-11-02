import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("CSP and HSTS protect redirects and errors using the configured public origin", () => {
  const code = `
    import assert from 'node:assert/strict';
    import { NextRequest } from 'next/server';
    const imported = await import('./proxy.ts');
    const proxy = imported.proxy ?? imported.default.proxy;
    process.env.NODE_ENV = 'production';
    process.env.APP_ORIGIN = 'https://example.test';
    const secure = await proxy(new NextRequest('https://example.test/'));
    assert.equal(secure.status, 307);
    assert.equal(secure.headers.get('location'), 'https://example.test/login');
    assert.equal(secure.headers.get('strict-transport-security'), 'max-age=31536000');
    assert.doesNotMatch(secure.headers.get('content-security-policy'), /unsafe-inline|unsafe-eval/);
    const denied = await proxy(new NextRequest('https://example.test/api/auth/csrf'));
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('strict-transport-security'), 'max-age=31536000');
    assert.equal(denied.headers.get('x-content-type-options'), 'nosniff');
    assert.match(denied.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    process.env.APP_ORIGIN = 'http://127.0.0.1:3000';
    const local = await proxy(new NextRequest('http://127.0.0.1:3000/', {headers:{'x-forwarded-proto':'https'}}));
    assert.equal(local.headers.get('strict-transport-security'), null);
    process.env.NODE_ENV = 'development';
    process.env.APP_ORIGIN = 'https://example.test';
    const dev = await proxy(new NextRequest('https://example.test/'));
    assert.equal(dev.headers.get('strict-transport-security'), null);
    assert.match(dev.headers.get('content-security-policy'), /unsafe-eval/);
  `;
  const result = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("isolated stack enforces CSP, persists writable artifacts, and safely repairs a legacy volume", { timeout: 900000 }, async () => {
  const project = `eclipsefoundation${randomBytes(6).toString("hex")}`;
  const tempRoot = realpathSync(tmpdir());
  const temp = mkdtempSync(path.join(tempRoot, "eclipse-foundation-test-"));
  const override = path.join(temp, "compose.override.yml");
  writeFileSync(override, "services:\n  ingress:\n    ports: !override\n      - '127.0.0.1::8080'\n");
  const empty = path.join(temp, "empty.env");
  writeFileSync(empty, "", { mode: 0o600 });
  const bootstrap = randomBytes(24).toString("hex");
  const appPassword = randomBytes(24).toString("hex");
  const migrationPassword = randomBytes(24).toString("hex");
  const controlSecret = randomBytes(32).toString("hex");
  const egressSecret = randomBytes(32).toString("hex");
  const ownerPassword = randomBytes(24).toString("hex");
  const env = { ...process.env, COMPOSE_PROJECT_NAME: project,
    COMPOSE_FILE: [path.resolve("docker-compose.yml"), override].join(path.delimiter),
    COMPOSE_ENV_FILES: empty,
    POSTGRES_BOOTSTRAP_PASSWORD: bootstrap, POSTGRES_APP_PASSWORD: appPassword,
    POSTGRES_MIGRATOR_PASSWORD: migrationPassword, DESKTOP_CONTROL_SECRET: controlSecret, EGRESS_PROXY_SECRET: egressSecret,
    APP_ORIGIN: "http://127.0.0.1:3000",
    DATABASE_URL: `postgresql://eclipse_app:${appPassword}@postgres:5432/eclipse`,
    MIGRATION_DATABASE_URL: `postgresql://eclipse_migrator:${migrationPassword}@postgres:5432/eclipse` };
  const docker = (...args) => spawnSync("docker", args, { env, encoding: "utf8", timeout: 300000 });
  const check = (result, label) => {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    for (const secret of [bootstrap, appPassword, migrationPassword, controlSecret, egressSecret, ownerPassword]) assert.ok(!output.includes(secret), `${label}: credential leak`);
    assert.equal(result.status, 0, `${label}: ${output}`);
    return result.stdout.trim();
  };
  const compose = (...args) => docker("compose", ...args);
  const repair = () => spawnSync(process.execPath, ["scripts/artifacts-permissions.mjs"], { env, encoding: "utf8", timeout: 60000 });
  const nodeScript = (script) => spawnSync(process.execPath, [script], { env, encoding: "utf8", timeout: 120000 });
  let image;
  let unrelatedVolume;
  try {
    check(compose("up", "-d", "--build", "--wait", "--wait-timeout", "180"), "start five-service fixture");
    const services = check(compose("ps", "--format", "json"), "service health").split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(services.length, 5);
    assert.ok(services.every((service) => service.State === "running"));
    assert.equal(services.find((service) => service.Service === "postgres").Health, "healthy");
    const ingress = check(compose("ps", "-q", "ingress"), "find ingress");
    const binding = check(docker("port", ingress, "8080/tcp"), "localhost test port");
    assert.match(binding, /^127\.0\.0\.1:\d+$/);
    const base = `http://${binding}`;
    env.APP_ORIGIN = base;
    check(compose("up", "-d", "--no-deps", "--no-build", "--force-recreate", "app"), "configure exact ephemeral fixture origin");
    const app = check(compose("ps", "-q", "app"), "find app");
    image = check(docker("inspect", "--format", "{{.Image}}", app), "find image");
    check(nodeScript("scripts/db-provision.mjs"), "provision disposable database roles");
    check(nodeScript("scripts/db-migrate.mjs"), "migrate disposable database");
    const ready = async () => {
      let lastStatus = "unreachable";
      for (let attempt = 0; attempt < 30; attempt++) {
        try { const response = await fetch(`${base}/login`, { signal: AbortSignal.timeout(1500) }); lastStatus = String(response.status); if (response.ok) return; } catch { /* wait for restart */ }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      assert.fail(`app did not become available (${lastStatus})`);
    };
    await ready();
    const redirect = await fetch(base, { redirect: "manual" });
    assert.equal(redirect.status, 307);
    assert.equal(redirect.headers.get("location"), `${base}/login`);
    assert.equal(redirect.headers.get("x-content-type-options"), "nosniff");
    assert.match(redirect.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    const denied = await fetch(`${base}/api/auth/csrf`, { headers: { Cookie: "eclipse_session=fabricated", "x-owner-id": "fabricated" } });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("x-content-type-options"), "nosniff");
    assert.match(denied.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    const authPost = (route, body) => fetch(`${base}/api/auth/${route}`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const setup = await authPost("setup", { login: "http-audit@example.test", password: ownerPassword, timezone: "UTC" });
    assert.equal(setup.status, 200);
    const login = await authPost("login", { login: "http-audit@example.test", password: ownerPassword });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie?.startsWith("eclipse_session="));
    const nonces = new Set();
    let html;
    for (let request = 0; request < 2; request++) {
      const response = await fetch(base, { headers: { Cookie: cookie, "x-nonce": "UNTRUSTED_NONCE", "Content-Security-Policy": "script-src *", "X-Forwarded-Proto": "https" } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
      assert.equal(response.headers.get("x-frame-options"), "DENY");
      assert.equal(response.headers.get("strict-transport-security"), null, "untrusted forwarded scheme must not enable HSTS");
      const csp = response.headers.get("content-security-policy");
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /object-src 'none'/);
      assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|UNTRUSTED_NONCE/);
      const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
      assert.ok(nonce);
      nonces.add(nonce);
      html = await response.text();
      assert.match(html, /Eclipse Crew/);
      const scripts = [...html.matchAll(/<script\b[^>]*>/g)];
      assert.ok(scripts.length > 0);
      for (const [script] of scripts) assert.ok(script.includes(`nonce="${nonce}"`), "framework script must use the response nonce");
      for (const [style] of html.matchAll(/<style\b[^>]*>/g)) assert.ok(style.includes(`nonce="${nonce}"`));
      assert.match(response.headers.get("cache-control"), /no-store/);
    }
    assert.equal(nonces.size, 2, "nonce must change on each request");
    const assets = [...html.matchAll(/(?:src|href)="(\/_next\/static\/[^\"]+)"/g)].map((match) => match[1]);
    assert.ok(assets.length);
    for (const asset of new Set(assets)) {
      const response = await fetch(new URL(asset, base));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      await response.arrayBuffer();
    }
    const missing = await fetch(`${base}/missing-audit-page`, { headers: { Cookie: cookie } });
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("x-content-type-options"), "nosniff");
    assert.match(missing.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    const node = (code, user) => docker("exec", ...(user ? ["--user", user] : []), app, "node", "-e", code);
    check(node('const fs=require("node:fs"); if(process.getuid()!==1000)process.exit(1); fs.writeFileSync("/var/eclipse/artifacts/persist.txt","preserved");'), "non-root artifact write");
    check(compose("restart", "app"), "restart app");
    await ready();
    check(node('const fs=require("node:fs"); if(fs.readFileSync("/var/eclipse/artifacts/persist.txt","utf8")!=="preserved")process.exit(1);'), "artifact persistence");
    assert.notEqual(repair().status, 0, "repair must refuse a running app");
    check(node('const fs=require("node:fs"); fs.mkdirSync("/var/eclipse/artifacts/legacy",{mode:0o700}); fs.writeFileSync("/var/eclipse/artifacts/legacy/data.txt","legacy",{mode:0o600}); fs.symlinkSync("/app/package.json","/var/eclipse/artifacts/legacy/outside"); fs.chownSync("/var/eclipse/artifacts",0,0);', "0:0"), "legacy permissions fixture");
    check(compose("stop", "app"), "stop app for repair");
    check(repair(), "repair exact artifacts volume");
    check(compose("start", "app"), "start repaired app");
    await ready();
    check(node('const fs=require("node:fs"); const root="/var/eclipse/artifacts"; fs.accessSync(root,fs.constants.W_OK); if(fs.readFileSync(root+"/legacy/data.txt","utf8")!=="legacy" || (fs.statSync(root+"/legacy").mode&0o777)!==0o700 || (fs.statSync(root+"/legacy/data.txt").mode&0o777)!==0o600 || !fs.lstatSync(root+"/legacy/outside").isSymbolicLink() || fs.statSync("/app/package.json").uid!==1000) process.exit(1); fs.unlinkSync(root+"/legacy/outside"); fs.unlinkSync(root+"/legacy/data.txt"); fs.rmdirSync(root+"/legacy"); fs.unlinkSync(root+"/persist.txt");'), "preserved contents, modes and symlink boundaries");
    check(compose("logs", "--no-color"), "service logs contain no synthetic passwords");
    check(compose("stop", "app"), "stop fixture for refusal test");
    check(compose("rm", "-f", "app"), "remove disposable app container");
    unrelatedVolume = `${project}_unrelated`;
    check(docker("volume", "create", "--label", `com.docker.compose.project=${project}`, "--label", "com.docker.compose.volume=unrelated", unrelatedVolume), "create mislabeled fixture volume");
    check(docker("create", "--name", `${project}-app-1`, "--label", `com.docker.compose.project=${project}`, "--label", "com.docker.compose.service=app", "--label", "com.docker.compose.config-hash=fixture",
      "--mount", `type=volume,src=${unrelatedVolume},dst=/var/eclipse/artifacts`, image), "create stopped refusal fixture");
    assert.notEqual(repair().status, 0, "repair must refuse a volume without the artifacts label");
  } finally {
    for (const [kind, listing, template] of [
      ["container", ["ps", "-aq"], '{{ index .Config.Labels "com.docker.compose.project" }}'],
      ["network", ["network", "ls", "-q"], '{{ index .Labels "com.docker.compose.project" }}'],
      ["volume", ["volume", "ls", "-q"], '{{ index .Labels "com.docker.compose.project" }}'],
    ]) {
      const ids = check(docker(...listing, "--filter", `label=com.docker.compose.project=${project}`), "identify test resources").split(/\r?\n/).filter(Boolean);
      for (const id of ids) assert.equal(check(docker(kind, "inspect", "--format", template, id), "verify cleanup label"), project);
    }
    check(compose("down", "--volumes", "--remove-orphans"), "remove isolated project");
    if (unrelatedVolume) check(docker("volume", "rm", unrelatedVolume), "remove labeled refusal fixture volume");
    if (image) {
      const tag = `${project}-app:latest`;
      const tags = JSON.parse(check(docker("image", "inspect", "--format", "{{json .RepoTags}}", image), "verify image tag"));
      assert.ok(tags.includes(tag));
      check(docker("image", "rm", tag), "remove disposable image tag");
    }
    const resolved = realpathSync(temp);
    assert.equal(path.dirname(resolved), tempRoot);
    assert.ok(path.basename(resolved).startsWith("eclipse-foundation-test-"));
    rmSync(resolved, { recursive: true, force: true });
  }
});
