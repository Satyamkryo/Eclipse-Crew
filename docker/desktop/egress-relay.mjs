import net from "node:net";
import { chmod, unlink } from "node:fs/promises";

// TASK-071. The supervisor-side relay is the only thing that knows an agent's egress token. It listens on a pathname
// socket inside the agent's 0700 directory, replaces any Proxy-Authorization the client sent, and tunnels bytes to the
// real egress proxy. The agent (and Chromium) only ever see a plain proxy on 127.0.0.1:3128 inside their namespace.

export const MAX_RELAY_CONNECTIONS = 64;
export const HEAD_LIMIT = 16 * 1024;
export const HEAD_TIMEOUT_MS = 5_000;
export const IDLE_TIMEOUT_MS = 120_000;
export const LIFETIME_MS = 30 * 60_000;

export function rewriteHead(head, authorization) {
  const lines = head.split("\r\n").filter((line) => line && !/^proxy-authorization\s*:/i.test(line));
  lines.push(`Proxy-Authorization: ${authorization}`);
  return `${lines.join("\r\n")}\r\n\r\n`;
}

export function basicAgentToken(agentId, token) {
  return `Basic ${Buffer.from(`${agentId}:${token}`, "utf8").toString("base64")}`;
}

export function createEgressRelay({
  agentId, path, token, upstream = { host: "egress-proxy", port: 4321 },
  log = () => {},
}) {
  if (!/^[0-9a-f-]{36}$/.test(agentId) || typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) throw new Error("invalid_relay_config");
  if (typeof path !== "string" || !path.startsWith("/")) throw new Error("invalid_relay_path");
  const sockets = new Set();
  const authorization = basicAgentToken(agentId, token);
  const server = net.createServer((client) => {
    if (sockets.size >= MAX_RELAY_CONNECTIONS) { client.destroy(); return; }
    sockets.add(client);
    client.setTimeout(IDLE_TIMEOUT_MS, () => client.destroy());
    const lifetime = setTimeout(() => client.destroy(), LIFETIME_MS);
    lifetime.unref?.();
    let buffered = Buffer.alloc(0);
    let connected = false;
    let upstreamSocket;
    const headTimer = setTimeout(() => client.destroy(), HEAD_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(headTimer);
      clearTimeout(lifetime);
      sockets.delete(client);
      try { upstreamSocket?.destroy(); } catch { /* already closed */ }
      try { client.destroy(); } catch { /* already closed */ }
    };
    client.once("close", cleanup);
    client.once("error", cleanup);
    const onData = (chunk) => {
      if (connected) return;
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > HEAD_LIMIT) { cleanup(); return; }
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      clearTimeout(headTimer);
      client.pause();
      client.off("data", onData);
      const head = buffered.subarray(0, end + 4);
      const rest = buffered.subarray(end + 4);
      upstreamSocket = net.connect({ host: upstream.host, port: upstream.port }, () => {
        connected = true;
        upstreamSocket.write(rewriteHead(head.toString("latin1"), authorization), "latin1");
        if (rest.length) upstreamSocket.write(rest);
        client.pipe(upstreamSocket);
        upstreamSocket.pipe(client);
        client.resume();
      });
      upstreamSocket.once("error", () => { log({ event: "relay_upstream_error" }); cleanup(); });
    };
    client.on("data", onData);
  });
  server.maxConnections = MAX_RELAY_CONNECTIONS;
  return {
    path,
    listen: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, async () => {
        try { await chmod(path, 0o600); } catch { /* the 0700 directory is the boundary */ }
        resolve();
      });
    }),
    close: () => new Promise((resolve) => {
      for (const socket of [...sockets]) { try { socket.destroy(); } catch { /* closed */ } }
      sockets.clear();
      server.close(() => { void unlink(path).catch(() => undefined).then(resolve); });
      setTimeout(() => resolve(), 1_000).unref?.();
    }),
    stats: () => ({ connections: sockets.size }),
  };
}

// TASK-073b. The git gateway uses a line preface instead of a proxy header. The relay writes the
// agent identity itself, so nothing the agent sends can choose or forge it.
export const MAX_GATEWAY_CONNECTIONS = 16;
export function createGatewayRelay({ agentId, path, token, upstream = { host: "egress-proxy", port: 4322 }, log = () => {} }) {
  if (!/^[0-9a-f-]{36}$/.test(agentId) || typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) throw new Error("invalid_relay_config");
  if (typeof path !== "string" || !path.startsWith("/")) throw new Error("invalid_relay_path");
  const sockets = new Set();
  const preface = `ECLIPSE-AGENT ${agentId} ${token}\n`;
  const server = net.createServer((client) => {
    if (sockets.size >= MAX_GATEWAY_CONNECTIONS) { client.destroy(); return; }
    sockets.add(client);
    client.setTimeout(IDLE_TIMEOUT_MS, () => client.destroy());
    const lifetime = setTimeout(() => client.destroy(), LIFETIME_MS); lifetime.unref?.();
    const upstreamSocket = net.connect({ host: upstream.host, port: upstream.port }, () => {
      upstreamSocket.write(preface, "latin1");
      client.pipe(upstreamSocket); upstreamSocket.pipe(client);
    });
    const cleanup = () => {
      clearTimeout(lifetime); sockets.delete(client);
      try { upstreamSocket.destroy(); } catch { /* already closed */ }
      try { client.destroy(); } catch { /* already closed */ }
    };
    upstreamSocket.once("error", () => { log({ event: "gateway_relay_error" }); cleanup(); });
    client.once("close", cleanup); client.once("error", cleanup);
  });
  server.maxConnections = MAX_GATEWAY_CONNECTIONS;
  return {
    path,
    listen: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, async () => {
        try { await chmod(path, 0o600); } catch { /* the 0700 directory is the boundary */ }
        resolve();
      });
    }),
    close: () => new Promise((resolve) => {
      for (const socket of [...sockets]) { try { socket.destroy(); } catch { /* closed */ } }
      sockets.clear();
      server.close(() => { void unlink(path).catch(() => undefined).then(resolve); });
      setTimeout(() => resolve(), 1_000).unref?.();
    }),
    stats: () => ({ connections: sockets.size }),
  };
}

// Inside the agent namespace: 127.0.0.1:3128 -> the supervisor's Unix socket.
export function startTcpToSocketForwarder({ port = 3128, socketPath, host = "127.0.0.1" }) {
  const sockets = new Set();
  const server = net.createServer((client) => {
    sockets.add(client);
    const upstream = net.connect(socketPath);
    const cleanup = () => { sockets.delete(client); try { upstream.destroy(); } catch { /* */ } try { client.destroy(); } catch { /* */ } };
    client.once("close", cleanup); client.once("error", cleanup);
    upstream.once("close", cleanup); upstream.once("error", cleanup);
    client.pipe(upstream); upstream.pipe(client);
  });
  server.maxConnections = MAX_RELAY_CONNECTIONS;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve({
      port: server.address().port,
      close: () => new Promise((done) => {
        for (const socket of [...sockets]) { try { socket.destroy(); } catch { /* */ } }
        server.close(() => done());
      }),
    }));
  });
}

// Inside the agent namespace: a pathname socket the controller can reach -> x11vnc on loopback.
export function startSocketToTcpForwarder({ socketPath, port, host = "127.0.0.1" }) {
  const sockets = new Set();
  const server = net.createServer((client) => {
    sockets.add(client);
    const upstream = net.connect({ host, port });
    const cleanup = () => { sockets.delete(client); try { upstream.destroy(); } catch { /* */ } try { client.destroy(); } catch { /* */ } };
    client.once("close", cleanup); client.once("error", cleanup);
    upstream.once("close", cleanup); upstream.once("error", cleanup);
    client.pipe(upstream); upstream.pipe(client);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, async () => {
      try { await chmod(socketPath, 0o600); } catch { /* the directory is the boundary */ }
      resolve({
        close: () => new Promise((done) => {
          for (const socket of [...sockets]) { try { socket.destroy(); } catch { /* */ } }
          server.close(() => { void unlink(socketPath).catch(() => undefined).then(done); });
          setTimeout(() => done(), 1_000).unref?.();
        }),
      });
    });
  });
}
