import net from "node:net";
import { vncChallengeResponse } from "./vnc-session.mjs";

const LIMIT = 8 * 1024 * 1024;
const CLIENT_LIMIT = 64 * 1024;
const VERSION = Buffer.from("RFB 003.008\n");
const NAME = Buffer.from("Agent desktop");
// Deliberately exclude desktop resize, clipboard, fence, continuous updates,
// extended keyboard and other pseudo-encodings that enable extra client verbs.
const SAFE_ENCODINGS = new Set([0, 1, 2, 5, 6, 7, 16, 21, -260, -224, -239]);
for (let n = -32; n <= -23; n++) SAFE_ENCODINGS.add(n);
for (let n = -256; n <= -247; n++) SAFE_ENCODINGS.add(n);

function pixelFormatValid(buffer, offset) {
  if (buffer[offset] !== 32 || ![24, 32].includes(buffer[offset + 1]) || ![0, 1].includes(buffer[offset + 2]) || buffer[offset + 3] === 0) return false;
  for (const relative of [4, 6, 8]) if (buffer.readUInt16BE(offset + relative) !== 255) return false;
  const shifts = [buffer[offset + 10], buffer[offset + 11], buffer[offset + 12]];
  return new Set(shifts).size === 3 && shifts.every((shift) => [0, 8, 16, 24].includes(shift));
}

/** The caller has already authenticated/owner-scoped this WebSocket. Credentials
 * and TCP never leave the controller; the browser gets a separate None-auth RFB
 * session that is protocol-filtered to framebuffer requests only.
 */
export function bridgeRfb(ws, { socket, port, password, onClose, onActivity } = {}) {
  const socketPath = typeof socket === "string" && /^\/run\/eclipse-ns\/[0-9a-f-]{36}\/vnc\.sock$/.test(socket) ? socket : null;
  if (!socketPath && (!Number.isInteger(port) || port < 5950 || port > 45949)) throw new Error("invalid_vnc_transport");
  if (typeof password !== "string" || !/^[\x21-\x7e]{8}$/.test(password)) throw new Error("invalid_vnc_transport");
  let closed = false, readyDone = false, tcpState = "version", clientState = "version";
  let upstream = Buffer.alloc(0), client = Buffer.alloc(0);
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // A caller may use only close/onClose; still consume an early handshake failure.
  void ready.catch(() => {});
  const tcp = socketPath ? net.connect({ path: socketPath }) : net.connect({ host: "127.0.0.1", port });
  tcp.setNoDelay(true);
  const deadline = setTimeout(() => finish(1008), 5000);
  deadline.unref();

  function finish(code = 1000) {
    if (closed) return;
    closed = true; clearTimeout(deadline); password = undefined;
    upstream = Buffer.alloc(0); client = Buffer.alloc(0); tcp.destroy();
    if (!readyDone) rejectReady(new Error("rfb_handshake_failed"));
    if (ws.readyState === 1) ws.close(code, "Desktop stream ended");
    const kill = setTimeout(() => { if (ws.readyState !== 3) ws.terminate(); }, 1000);
    kill.unref();
    try { void Promise.resolve(onClose?.()).catch(() => {}); } catch { /* Caller cleanup must not interrupt transport cleanup. */ }
  }
  function activity() { try { onActivity?.(); } catch { finish(1011); } }
  function browserSend(data) {
    if (closed) return;
    if (ws.readyState !== 1 || data.length > LIMIT || ws.bufferedAmount + data.length > LIMIT) return finish(1008);
    ws.send(data, { binary: true }, (error) => { if (error) finish(1011); });
  }
  function upstreamSend(data) {
    if (closed) return;
    if (tcp.destroyed || tcp.writableLength + data.length > LIMIT) return finish(1008);
    if (!tcp.write(data)) ws.pause();
  }
  tcp.on("drain", () => { if (!closed) ws.resume(); });
  function beginServerInit() {
    if (tcpState === "authenticated" && clientState === "waiting") {
      tcpState = "serverInit"; upstreamSend(Buffer.from([1]));
    }
  }
  function parseServer() {
    while (!closed) {
      if (tcpState === "version") {
        if (upstream.length < 12) return;
        if (!upstream.subarray(0, 12).equals(VERSION)) return finish(1008);
        upstream = upstream.subarray(12); upstreamSend(VERSION); tcpState = "security";
      } else if (tcpState === "security") {
        if (!upstream.length) return;
        const count = upstream[0];
        if (!count || count > 64) return finish(1008);
        if (upstream.length < 1 + count) return;
        if (!upstream.subarray(1, 1 + count).includes(2)) return finish(1008);
        upstream = upstream.subarray(1 + count); upstreamSend(Buffer.from([2])); tcpState = "challenge";
      } else if (tcpState === "challenge") {
        if (upstream.length < 16) return;
        const response = vncChallengeResponse(password, upstream.subarray(0, 16));
        password = undefined; upstream = upstream.subarray(16);
        upstreamSend(response); tcpState = "securityResult";
      } else if (tcpState === "securityResult") {
        if (upstream.length < 4) return;
        if (upstream.readUInt32BE(0) !== 0) return finish(1008);
        upstream = upstream.subarray(4); tcpState = "authenticated"; beginServerInit();
      } else if (tcpState === "authenticated") {
        // A real server sends nothing until the browser has supplied ClientInit.
        if (upstream.length) finish(1008);
        return;
      } else if (tcpState === "serverInit") {
        if (upstream.length < 24) return;
        const nameLength = upstream.readUInt32BE(20);
        if (upstream.readUInt16BE(0) !== 1024 || upstream.readUInt16BE(2) !== 768 || !pixelFormatValid(upstream, 4) || nameLength > 4096) return finish(1008);
        if (upstream.length < 24 + nameLength) return;
        const header = Buffer.from(upstream.subarray(0, 24)); header.writeUInt32BE(NAME.length, 20);
        upstream = upstream.subarray(24 + nameLength);
        browserSend(Buffer.concat([header, NAME]));
        if (closed) return;
        tcpState = "active"; clientState = "active"; readyDone = true; clearTimeout(deadline); resolveReady();
        parseClient();
      } else if (tcpState === "active") {
        if (upstream.length) { browserSend(upstream); upstream = Buffer.alloc(0); }
        return;
      } else return finish(1008);
    }
  }
  function parseClient() {
    while (!closed) {
      if (clientState === "version") {
        if (client.length < 12) return;
        if (!client.subarray(0, 12).equals(VERSION)) return finish(1008);
        client = client.subarray(12); browserSend(Buffer.from([1, 1])); clientState = "security";
      } else if (clientState === "security") {
        if (!client.length) return;
        if (client[0] !== 1) return finish(1008);
        client = client.subarray(1); browserSend(Buffer.alloc(4)); clientState = "clientInit";
      } else if (clientState === "clientInit") {
        if (!client.length) return;
        if (client[0] !== 1) return finish(1008);
        client = client.subarray(1); clientState = "waiting"; beginServerInit();
      } else if (clientState === "waiting") return;
      else if (clientState === "active") {
        if (!client.length) return;
        const type = client[0];
        if (type === 0) {
          if (client.length < 20) return;
          if (!pixelFormatValid(client, 4)) return finish(1008);
          upstreamSend(client.subarray(0, 20)); client = client.subarray(20);
        } else if (type === 2) {
          if (client.length < 4) return;
          const count = client.readUInt16BE(2);
          if (count > 128) return finish(1008);
          if (client.length < 4 + count * 4) return;
          const encodings = [];
          for (let i = 0; i < count; i++) {
            const encoding = client.readInt32BE(4 + i * 4);
            if (SAFE_ENCODINGS.has(encoding) && !encodings.includes(encoding)) encodings.push(encoding);
          }
          if (!encodings.includes(0)) encodings.push(0);
          const message = Buffer.alloc(4 + encodings.length * 4);
          message[0] = 2; message.writeUInt16BE(encodings.length, 2);
          encodings.forEach((encoding, index) => message.writeInt32BE(encoding, 4 + index * 4));
          upstreamSend(message); client = client.subarray(4 + count * 4);
        } else if (type === 3) {
          if (client.length < 10) return;
          const x = client.readUInt16BE(2), y = client.readUInt16BE(4), width = client.readUInt16BE(6), height = client.readUInt16BE(8);
          if (client[1] > 1 || !width || !height || x + width > 1024 || y + height > 768) return finish(1008);
          upstreamSend(client.subarray(0, 10)); client = client.subarray(10);
        } else return finish(1008);
        activity();
      } else return finish(1008);
    }
  }
  tcp.on("data", (data) => {
    if (closed) return;
    if (upstream.length + data.length > LIMIT) return finish(1008);
    upstream = Buffer.concat([upstream, data]);
    try { parseServer(); } catch { finish(1008); }
  });
  tcp.on("error", () => finish(1011)); tcp.on("close", () => finish(1000));
  ws.on("message", (data, binary) => {
    if (closed) return;
    if (!binary || data.length + client.length > CLIENT_LIMIT) return finish(1008);
    client = Buffer.concat([client, data]);
    try { parseClient(); } catch { finish(1008); }
  });
  ws.on("error", () => finish(1011)); ws.on("close", () => finish(1000));
  browserSend(VERSION);
  return { ready, close: () => finish(1000) };
}
