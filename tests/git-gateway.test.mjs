import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import net from "node:net";
import { createHash } from "node:crypto";
import { createGitGateway, parsePktLines, classifyPush, parseGatewayPath, validatePreface } from "../docker/egress/git-gateway.mjs";
import { createRegistry, egressToken } from "../docker/egress/registry.mjs";
import { createCredentialStore } from "../docker/egress/credentials.mjs";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECRET = createHash("sha256").update("synthetic-gateway-secret").digest("hex");
const TOKEN = "ghp_synthetic_gateway_token_1234567890";
const OLD = "a".repeat(40), NEW = "b".repeat(40), ZERO = "0".repeat(40);
const pkt = (text) => { const body = Buffer.from(text); return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0")), body]); };
const flush = Buffer.from("0000");
const preface = (agent = AGENT, secret = SECRET) => `ECLIPSE-AGENT ${agent} ${egressToken(secret, agent)}\n`;

function fakeUpstream(record) {
  return (options, onResponse) => {
    record.options.push(options);
    const request = new EventEmitter();
    request.write = (chunk) => { record.body.push(Buffer.from(chunk)); };
    request.destroy = () => {};
    request.end = () => {
      record.ended = true;
      const response = new EventEmitter();
      response.statusCode = 200; response.statusMessage = "OK";
      response.headers = { "content-type": "application/x-git-upload-pack-advertisement", "cache-control": "no-cache" };
      onResponse(response);
      setImmediate(() => { response.emit("data", Buffer.from("upstream-ok")); response.emit("end"); });
    };
    return request;
  };
}
function request(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }); const chunks = [];
    socket.setTimeout(5000, () => { socket.destroy(); reject(Error("timeout")); });
    socket.once("connect", () => socket.write(text));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
  });
}
const status = (response) => +/^HTTP\/1\.1 (\d{3})/.exec(response)?.[1];

test("pkt-line parser covers create, update, delete, multiple commands, capabilities, truncation and push-cert", () => {
  const first = `${ZERO} ${NEW} refs/heads/fix-1\0report-status side-band-64k\n`;
  const parsed = parsePktLines(Buffer.concat([pkt(first), flush]));
  assert.equal(parsed.complete, true);
  assert.deepEqual(parsed.commands, [{ old: ZERO, new: NEW, ref: "refs/heads/fix-1" }]);
  assert.equal(parsed.capabilities, "report-status side-band-64k");
  const multiple = parsePktLines(Buffer.concat([pkt(`${ZERO} ${NEW} refs/heads/a\0report-status\n`), pkt(`${OLD} ${NEW} refs/heads/b\n`), flush]));
  assert.equal(multiple.commands.length, 2);
  const deletion = parsePktLines(Buffer.concat([pkt(`${OLD} ${ZERO} refs/heads/old\0report-status\n`), flush]));
  assert.equal(deletion.commands[0].new, ZERO);
  const truncated = parsePktLines(pkt(`${ZERO} ${NEW} refs/heads/a\0report-status\n`));
  assert.equal(truncated.complete, false);
  assert.equal(truncated.commands.length, 1);
  assert.equal(parsePktLines(pkt(`push-cert\0report-status\n`)).error, "push_cert_refused");
  assert.equal(parsePktLines(pkt(`${ZERO} ${NEW} refs/remotes/origin/x\n`)).error, "invalid_push_command");
  assert.equal(parsePktLines(Buffer.from("zzzz")).error, "invalid_pkt_line");
  const many = []; for (let i = 0; i < 1200; i++) many.push(pkt(`${ZERO} ${NEW} refs/heads/b${i}\n`)); many.push(flush);
  assert.equal(parsePktLines(Buffer.concat(many)).error, "pkt_line_too_large");
});

test("push classification names default-branch, delete, tag-move and lookup-failure cases", () => {
  assert.equal(classifyPush([{ old: ZERO, new: NEW, ref: "refs/heads/new" }], "main").allowed, true);
  assert.equal(classifyPush([{ old: ZERO, new: NEW, ref: "refs/tags/v1" }], "main").allowed, true);
  assert.equal(classifyPush([{ old: OLD, new: NEW, ref: "refs/heads/fix-1" }], "main").allowed, true);
  assert.equal(classifyPush([{ old: OLD, new: NEW, ref: "refs/heads/main" }], "main").blocked[0].kind, "default_branch");
  assert.equal(classifyPush([{ old: OLD, new: ZERO, ref: "refs/heads/fix-1" }], "main").blocked[0].class, "delete");
  assert.equal(classifyPush([{ old: OLD, new: ZERO, ref: "refs/tags/v1" }], "main").blocked[0].kind, "delete");
  assert.equal(classifyPush([{ old: OLD, new: NEW, ref: "refs/tags/v1" }], "main").blocked[0].kind, "tag_update");
  assert.equal(classifyPush([{ old: OLD, new: NEW, ref: "refs/heads/fix-1" }], null).blocked[0].kind, "default_branch");
  assert.equal(classifyPush([{ old: OLD, new: NEW, ref: "refs/heads/main" }, { old: ZERO, new: NEW, ref: "refs/heads/other" }], "main").allowed, false);
});

test("gateway path and preface accept only github.com repos and the relay's HMAC", () => {
  assert.deepEqual(parseGatewayPath("/git/github.com/owner/repo.git/info/refs?service=git-upload-pack").service, "git-upload-pack");
  assert.equal(parseGatewayPath("/git/github.com/owner/repo.git/git-receive-pack").method, "POST");
  assert.equal(parseGatewayPath("/git/gitlab.com/owner/repo.git/info/refs?service=git-upload-pack"), null);
  assert.equal(parseGatewayPath("/git/github.com/../repo.git/info/refs?service=git-upload-pack"), null);
  assert.equal(parseGatewayPath("/git/github.com/owner/repo.git/info/refs?service=git-receive-pack&x=1"), null);
  assert.equal(validatePreface(preface(), SECRET), AGENT);
  assert.equal(validatePreface(preface(AGENT, createHash("sha256").update("other").digest("hex")), SECRET), null);
  assert.equal(validatePreface("ECLIPSE-AGENT not-a-uuid " + "0".repeat(64) + "\n", SECRET), null);
});

test("live gateway strips client credentials, injects the bound Basic token and refuses blocked pushes", async () => {
  const registry = createRegistry(); registry.setPolicy(AGENT, ["github.com"], false);
  const credentials = createCredentialStore(); credentials.set(AGENT, [{ host: "github.com", scheme: "basic", username: "x-access-token", token: TOKEN }]);
  const record = { options: [], body: [], ended: false }; const logs = [];
  const gateway = createGitGateway({ desktopSecret: SECRET, registry, credentials, upstream: fakeUpstream(record), resolve: async () => [{ address: "140.82.121.4", family: 4 }],
    lookupDefaultBranch: async () => "main", log: (event) => logs.push(event) });
  const address = await gateway.listen(0, "127.0.0.1");
  try {
    const get = await request(address.port, `${preface()}GET /git/github.com/owner/repo.git/info/refs?service=git-upload-pack HTTP/1.1\r\nHost: 127.0.0.1:3129\r\nAuthorization: Bearer attacker\r\n\r\n`);
    assert.equal(status(get), 200);
    assert.match(get, /upstream-ok/);
    assert.equal(record.options.length, 1);
    assert.equal(record.options[0].path, "/owner/repo.git/info/refs?service=git-upload-pack");
    assert.match(record.options[0].headers.authorization, /^Basic /);
    assert.equal(record.options[0].headers.authorization.includes("attacker"), false);
    assert.equal(record.options[0].headers.authorization.includes(Buffer.from(`x-access-token:${TOKEN}`).toString("base64")), true);

    const blockedBody = Buffer.concat([pkt(`${OLD} ${NEW} refs/heads/main\0report-status\n`), flush]);
    const before = record.options.length;
    const blocked = await request(address.port, `${preface()}POST /git/github.com/owner/repo.git/git-receive-pack HTTP/1.1\r\nHost: 127.0.0.1:3129\r\nContent-Type: application/x-git-receive-pack-request\r\nContent-Length: ${blockedBody.length}\r\n\r\n${blockedBody.toString("latin1")}`);
    assert.equal(status(blocked), 403);
    assert.match(blocked, /push to main needs the owner/);
    assert.equal(record.options.length, before, "blocked push never reaches GitHub");
    assert.equal(logs.at(-1).event, "git_push_blocked");
    assert.equal(JSON.stringify(logs).includes(TOKEN), false);
    assert.equal(blocked.includes(TOKEN), false);

    const allowedBody = Buffer.concat([pkt(`${ZERO} ${NEW} refs/heads/fix-1\0report-status\n`), flush, Buffer.from("PACK")]);
    const allowed = await request(address.port, `${preface()}POST /git/github.com/owner/repo.git/git-receive-pack HTTP/1.1\r\nHost: 127.0.0.1:3129\r\nContent-Type: application/x-git-receive-pack-request\r\nContent-Length: ${allowedBody.length}\r\n\r\n${allowedBody.toString("latin1")}`);
    assert.equal(status(allowed), 200);
    assert.equal(record.options.length, before + 1);
    assert.equal(Buffer.concat(record.body).toString("latin1").includes("PACK"), true);

    const forged = await request(address.port, `ECLIPSE-AGENT ${AGENT} ${"0".repeat(64)}\nGET /git/github.com/owner/repo.git/info/refs?service=git-upload-pack HTTP/1.1\r\n\r\n`);
    assert.equal(status(forged), 403);
    assert.equal(record.options.length, before + 1);
  } finally { await gateway.close(); }
});

test("gateway refuses encoding, unknown paths and missing credentials", async () => {
  const registry = createRegistry(); registry.setPolicy(AGENT, ["github.com"], false);
  const credentials = createCredentialStore(); credentials.set(AGENT, [{ host: "github.com", scheme: "basic", username: "u", token: TOKEN }]);
  const record = { options: [], body: [], ended: false };
  const gateway = createGitGateway({ desktopSecret: SECRET, registry, credentials, upstream: fakeUpstream(record), resolve: async () => [{ address: "140.82.121.4", family: 4 }],
    lookupDefaultBranch: async () => "main" });
  const address = await gateway.listen(0, "127.0.0.1");
  try {
    const gzip = await request(address.port, `${preface()}POST /git/github.com/owner/repo.git/git-upload-pack HTTP/1.1\r\nContent-Type: application/x-git-upload-pack-request\r\nContent-Encoding: gzip\r\nContent-Length: 4\r\n\r\nabcd`);
    assert.equal(status(gzip), 415);
    const otherHost = await request(address.port, `${preface()}GET /git/gitlab.com/owner/repo.git/info/refs?service=git-upload-pack HTTP/1.1\r\n\r\n`);
    assert.equal(status(otherHost), 404);
    credentials.set(AGENT, []);
    const missing = await request(address.port, `${preface()}GET /git/github.com/owner/repo.git/info/refs?service=git-upload-pack HTTP/1.1\r\n\r\n`);
    assert.equal(status(missing), 403);
    assert.match(missing, /credential_required/);
    assert.equal(record.options.length, 0);
  } finally { await gateway.close(); }
});
