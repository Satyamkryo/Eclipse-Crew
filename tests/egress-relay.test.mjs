import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  basicAgentToken, createEgressRelay, createGatewayRelay, rewriteHead, startSocketToTcpForwarder, startTcpToSocketForwarder,
} from "../docker/desktop/egress-relay.mjs";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOKEN = "ab".repeat(32);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}
function close(server) {
  return new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
}
function exchange(socketPath, payload, { encoding = "latin1" } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let data = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("timeout")); }, 5000);
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.on("data", (chunk) => { data += chunk.toString(encoding); });
    socket.once("close", () => { clearTimeout(timer); resolve(data); });
    socket.once("connect", () => socket.write(payload, encoding));
  });
}

test("the relay replaces any client Proxy-Authorization with the agent's own", () => {
  const head = "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: Basic Zm9yZ2Vk\r\n\r\n";
  const rewritten = rewriteHead(head, basicAgentToken(AGENT, TOKEN));
  assert.equal(rewritten.includes("Zm9yZ2Vk"), false);
  assert.match(rewritten, /^CONNECT example\.com:443 HTTP\/1\.1\r\n/);
  assert.equal(rewritten.match(/Proxy-Authorization:/gi).length, 1);
  assert.equal(rewritten.includes(basicAgentToken(AGENT, TOKEN)), true);
});

test("the relay injects the token only upstream and never returns it to the agent", { skip: process.platform === "win32" && "Unix domain sockets require Linux" }, async () => {
  const received = [];
  const upstream = net.createServer((socket) => {
    let head = "";
    socket.on("data", (chunk) => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      received.push(head);
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    });
  });
  const upstreamPort = await listen(upstream);
  const directory = await mkdtemp(path.join(tmpdir(), "relay-"));
  const socketPath = path.join(directory, "egress.sock");
  const relay = createEgressRelay({ agentId: AGENT, path: socketPath, token: TOKEN, upstream: { host: "127.0.0.1", port: upstreamPort } });
  await relay.listen();
  try {
    const response = await exchange(socketPath, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\nProxy-Authorization: Basic forged\r\n\r\n");
    assert.equal(received.length, 1);
    assert.equal(received[0].includes("forged"), false);
    assert.equal(received[0].includes(basicAgentToken(AGENT, TOKEN)), true);
    assert.equal(response.includes(TOKEN), false);
    assert.match(response, /200 OK/);
  } finally {
    await relay.close();
    await close(upstream);
    assert.equal(await import("node:fs/promises").then((fs) => fs.access(socketPath).then(() => true, () => false)), false, "socket removed");
    await rm(directory, { recursive: true, force: true });
  }
});

test("a malformed or oversized first head closes the connection", { skip: process.platform === "win32" && "Unix domain sockets require Linux" }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-"));
  const socketPath = path.join(directory, "egress.sock");
  const relay = createEgressRelay({ agentId: AGENT, path: socketPath, token: TOKEN, upstream: { host: "127.0.0.1", port: 9 } });
  await relay.listen();
  try {
    const response = await exchange(socketPath, "GET /" + "a".repeat(17 * 1024));
    assert.equal(response, "");
  } finally {
    await relay.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a tunnelled echo round trip works through both namespace forwarders", { skip: process.platform === "win32" && "Unix domain sockets require Linux" }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-"));
  const socketPath = path.join(directory, "egress.sock");
  const unixEcho = net.createServer((socket) => socket.on("data", (chunk) => socket.write(chunk)));
  await new Promise((resolve, reject) => { unixEcho.once("error", reject); unixEcho.listen(socketPath, resolve); });
  const tcpForward = await startTcpToSocketForwarder({ socketPath, port: 0 });
  const tcpTarget = await listen(net.createServer((socket) => socket.on("data", (chunk) => socket.write(chunk))));
  const vncSocket = path.join(directory, "vnc.sock");
  const socketForward = await startSocketToTcpForwarder({ socketPath: vncSocket, port: tcpTarget });
  try {
    const tcpResult = await new Promise((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port: tcpForward.port });
      socket.once("error", reject);
      socket.once("connect", () => socket.write("hello"));
      socket.once("data", (chunk) => { socket.destroy(); resolve(chunk.toString()); });
    });
    assert.equal(tcpResult, "hello");
    const socketResult = await new Promise((resolve, reject) => {
      const socket = net.connect(vncSocket);
      socket.once("error", reject);
      socket.once("connect", () => socket.write("vnc"));
      socket.once("data", (chunk) => { socket.destroy(); resolve(chunk.toString()); });
    });
    assert.equal(socketResult, "vnc");
  } finally {
    await tcpForward.close();
    await socketForward.close();
    await new Promise((resolve) => { unixEcho.close(resolve); unixEcho.closeAllConnections?.(); });
    await rm(directory, { recursive: true, force: true });
  }
});

test("the gateway relay prepends its own agent preface before any client bytes", { skip: process.platform === "win32" && "Unix domain sockets require Linux" }, async () => {
  const seen = [];
  const upstream = net.createServer((socket) => {
    let data = ""; socket.on("data", (chunk) => { data += chunk.toString("latin1"); if (data.includes("GET /")) { seen.push(data); socket.end("HTTP/1.1 200 OK\r\n\r\n"); } });
  });
  const upstreamPort = await listen(upstream);
  const directory = await mkdtemp(path.join(tmpdir(), "relay-"));
  const socketPath = path.join(directory, "gateway.sock");
  const relay = createGatewayRelay({ agentId: AGENT, path: socketPath, token: TOKEN, upstream: { host: "127.0.0.1", port: upstreamPort } });
  await relay.listen();
  try {
    const response = await exchange(socketPath, `ECLIPSE-AGENT ${AGENT} ${"0".repeat(64)}\nGET /git/github.com/o/r.git/info/refs?service=git-upload-pack HTTP/1.1\r\n\r\n`);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].startsWith(`ECLIPSE-AGENT ${AGENT} ${TOKEN}\n`), true);
    assert.equal(seen[0].includes(`ECLIPSE-AGENT ${AGENT} ${"0".repeat(64)}`), false, "the relay's preface is the first line");
    assert.equal(response.includes(TOKEN), false);
  } finally {
    await relay.close(); await close(upstream);
    await rm(directory, { recursive: true, force: true });
  }
});

test("two agents' relays keep their own identity", { skip: process.platform === "win32" && "Unix domain sockets require Linux" }, async () => {
  const seen = [];
  const upstream = net.createServer((socket) => {
    let head = "";
    socket.on("data", (chunk) => { head += chunk.toString("latin1"); if (head.includes("\r\n\r\n")) { seen.push(head); socket.end("HTTP/1.1 204 No Content\r\n\r\n"); } });
  });
  const upstreamPort = await listen(upstream);
  const directory = await mkdtemp(path.join(tmpdir(), "relay-"));
  const first = createEgressRelay({ agentId: AGENT, path: path.join(directory, "a.sock"), token: TOKEN, upstream: { host: "127.0.0.1", port: upstreamPort } });
  const second = createEgressRelay({ agentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", path: path.join(directory, "b.sock"), token: "cd".repeat(32), upstream: { host: "127.0.0.1", port: upstreamPort } });
  await first.listen(); await second.listen();
  try {
    await exchange(path.join(directory, "a.sock"), "CONNECT x.test:443 HTTP/1.1\r\n\r\n");
    await exchange(path.join(directory, "b.sock"), "CONNECT x.test:443 HTTP/1.1\r\n\r\n");
    assert.equal(seen[0].includes(basicAgentToken(AGENT, TOKEN)), true);
    assert.equal(seen[1].includes(basicAgentToken("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "cd".repeat(32))), true);
    assert.equal(seen[1].includes(basicAgentToken(AGENT, TOKEN)), false);
  } finally {
    await first.close(); await second.close(); await close(upstream);
    await rm(directory, { recursive: true, force: true });
  }
});
