import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import { createServer } from "node:http";
import { once } from "node:events";
import { createCipheriv } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { bridgeRfb } from "../docker/desktop/rfb-bridge.mjs";

const PASSWORD = "Abcd1234", VERSION = Buffer.from("RFB 003.008\n");
const challenge = Buffer.from("00112233445566778899aabbccddeeff", "hex");
function expectedResponse() {
  const key = Buffer.from([...PASSWORD].map((letter) => parseInt(letter.charCodeAt(0).toString(2).padStart(8, "0").split("").reverse().join(""), 2)));
  const cipher = createCipheriv("des-ede3", Buffer.concat([key, key, key]), null); cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(challenge), cipher.final()]);
}
function serverInit({ width = 1024, name = "private server identity", trueColor = 1 } = {}) {
  const header = Buffer.alloc(24); header.writeUInt16BE(width, 0); header.writeUInt16BE(768, 2);
  header[4] = 32; header[5] = 24; header[7] = trueColor;
  for (const offset of [8, 10, 12]) header.writeUInt16BE(255, offset);
  header[14] = 16; header[15] = 8; header[16] = 0;
  header.writeUInt32BE(Buffer.byteLength(name), 20);
  return Buffer.concat([header, Buffer.from(name)]);
}
function reader(ws) {
  let bytes = Buffer.alloc(0), waiter;
  ws.on("message", (chunk, binary) => {
    assert.equal(binary, true); bytes = Buffer.concat([bytes, chunk]); waiter?.();
  });
  return async (n) => {
    while (bytes.length < n) await new Promise((resolve) => { waiter = resolve; });
    const result = bytes.subarray(0, n); bytes = bytes.subarray(n); waiter = undefined; return result;
  };
}
async function fixture(t, options = {}) {
  const tcpPeers = new Set(), wsPeers = new Set(), commands = [];
  let responseAccepted = false, closeCount = 0, activityCount = 0, handle;
  const tcpServer = net.createServer((socket) => {
    tcpPeers.add(socket); socket.on("error", () => {}); socket.on("close", () => tcpPeers.delete(socket));
    let buffer = Buffer.alloc(0), state = "version";
    socket.write(VERSION.subarray(0, 5)); socket.write(VERSION.subarray(5));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        if (state === "version") {
          if (buffer.length < 12) return;
          assert.deepEqual(buffer.subarray(0, 12), VERSION); buffer = buffer.subarray(12);
          state = "security"; socket.write(Buffer.from([2, 1, 2]));
        } else if (state === "security") {
          if (!buffer.length) return;
          assert.equal(buffer[0], 2); buffer = buffer.subarray(1); state = "auth"; socket.write(challenge);
        } else if (state === "auth") {
          if (buffer.length < 16) return;
          responseAccepted = buffer.subarray(0, 16).equals(expectedResponse());
          buffer = buffer.subarray(16); state = "clientInit";
          const result = Buffer.alloc(4); result.writeUInt32BE(options.authFailure ? 1 : 0);
          socket.write(result);
        } else if (state === "clientInit") {
          if (!buffer.length) return;
          assert.equal(buffer[0], 1); buffer = buffer.subarray(1); state = "active";
          socket.write(serverInit(options));
        } else {
          if (!buffer.length) return;
          const type = buffer[0];
          const length = type === 0 ? 20 : type === 2 ? buffer.length >= 4 ? 4 + buffer.readUInt16BE(2) * 4 : 4 : type === 3 ? 10 : 1;
          if (buffer.length < length) return;
          commands.push(Buffer.from(buffer.subarray(0, length))); buffer = buffer.subarray(length);
          if (type === 3) {
            const update = Buffer.alloc(20); update.writeUInt16BE(1, 2); update.writeUInt16BE(1, 8); update.writeUInt16BE(1, 10); update[18] = 255;
            socket.write(update);
          }
        }
      }
    });
  });
  // The production port validator intentionally admits only the derived VNC range.
  for (let attempt = 0; ; attempt++) {
    try {
      tcpServer.listen(42000 + Math.floor(Math.random() * 2000), "127.0.0.1"); await once(tcpServer, "listening"); break;
    } catch (error) { if (error.code !== "EADDRINUSE" || attempt > 30) throw error; }
  }
  const http = createServer(), wss = new WebSocketServer({ server: http });
  wss.on("connection", (ws) => {
    wsPeers.add(ws); ws.on("close", () => wsPeers.delete(ws));
    handle = bridgeRfb(ws, { port: tcpServer.address().port, password: PASSWORD,
      onClose: () => { closeCount++; }, onActivity: () => { activityCount++; } });
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const client = new WebSocket(`ws://127.0.0.1:${http.address().port}`);
  const read = reader(client); await once(client, "open");
  t.after(async () => {
    client.terminate(); handle?.close();
    for (const ws of wsPeers) ws.terminate();
    for (const socket of tcpPeers) socket.destroy();
    await Promise.all([new Promise((resolve) => http.close(resolve)), new Promise((resolve) => tcpServer.close(resolve))]);
    wss.close();
  });
  return { client, read, commands, get handle() { return handle; }, get responseAccepted() { return responseAccepted; }, get closeCount() { return closeCount; }, get activityCount() { return activityCount; } };
}
async function handshake(f) {
  assert.deepEqual(await f.read(12), VERSION);
  f.client.send(VERSION.subarray(0, 4)); f.client.send(VERSION.subarray(4));
  assert.deepEqual(await f.read(2), Buffer.from([1, 1]));
  f.client.send(Buffer.from([1])); assert.deepEqual(await f.read(4), Buffer.alloc(4));
  f.client.send(Buffer.from([1]));
  const header = await f.read(24); assert.equal(header.readUInt16BE(0), 1024); assert.equal(header.readUInt16BE(2), 768);
  assert.equal((await f.read(header.readUInt32BE(20))).toString(), "Agent desktop");
  await f.handle.ready; assert.equal(f.responseAccepted, true);
}
function updateRequest(x = 0, y = 0, width = 1024, height = 768) {
  const message = Buffer.alloc(10); message[0] = 3;
  for (const [offset, value] of [[2, x], [4, y], [6, width], [8, height]]) message.writeUInt16BE(value, offset);
  return message;
}
test("RFB bridge performs private VNC authentication and relays pixels with sanitized None-auth init", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); await handshake(f);
  const pixelFormat = Buffer.concat([Buffer.alloc(4), serverInit().subarray(4, 20)]);
  const encodings = [7, 0, -224, -239, -312, -313, -223, -308, -1063131698];
  const request = Buffer.alloc(4 + encodings.length * 4); request[0] = 2; request.writeUInt16BE(encodings.length, 2);
  encodings.forEach((encoding, i) => request.writeInt32BE(encoding, 4 + i * 4));
  f.client.send(Buffer.concat([pixelFormat, request, updateRequest()]));
  const pixels = await f.read(20); assert.equal(pixels[18], 255);
  assert.deepEqual(f.commands[0], pixelFormat);
  const forwarded = f.commands[1]; assert.equal(forwarded.readUInt16BE(2), 4);
  assert.deepEqual(Array.from({ length: 4 }, (_, i) => forwarded.readInt32BE(4 + i * 4)), [7, 0, -224, -239]);
  assert.equal(f.activityCount, 3);
});
test("RFB accepts nonzero true-color flags as specified by RFC 6143", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { trueColor: 255 }); await handshake(f);
  f.client.send(updateRequest()); assert.equal((await f.read(20))[18], 255);
});
for (const type of [4, 5, 6, 150, 248, 251, 255]) test(`RFB view-only bridge rejects client type ${type} before TCP forwarding`, { timeout: 5000 }, async (t) => {
  const f = await fixture(t); await handshake(f);
  const closed = once(f.client, "close"); f.client.send(Buffer.from([type, 0, 0, 0]));
  assert.equal((await closed)[0], 1008); assert.equal(f.commands.length, 0); assert.equal(f.closeCount, 1);
});
test("RFB rejects out of screen framebuffer requests", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); await handshake(f);
  const closed = once(f.client, "close"); f.client.send(updateRequest(1023, 0, 2, 768));
  assert.equal((await closed)[0], 1008); assert.equal(f.commands.length, 0);
});
test("RFB rejects oversized binary messages before TCP forwarding", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); await handshake(f);
  const closed = once(f.client, "close"); f.client.send(Buffer.alloc(65537));
  assert.equal((await closed)[0], 1008); assert.equal(f.commands.length, 0);
});
test("RFB rejects text frames before TCP forwarding", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); await handshake(f);
  const closed = once(f.client, "close"); f.client.send("not RFB");
  assert.equal((await closed)[0], 1008); assert.equal(f.commands.length, 0);
});
test("RFB rejects failed private VNC authentication", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { authFailure: true });
  const closed = once(f.client, "close"); assert.equal((await closed)[0], 1008);
  await assert.rejects(f.handle.ready, /rfb_handshake_failed/); assert.equal(f.closeCount, 1);
});
test("RFB bounds pending handshake to five seconds", { timeout: 7000 }, async (t) => {
  const start = Date.now(), f = await fixture(t);
  assert.equal((await once(f.client, "close"))[0], 1008);
  await assert.rejects(f.handle.ready, /rfb_handshake_failed/);
  assert.ok(Date.now() - start < 6500);
});
test("RFB rejects unsupported server dimensions", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { width: 2048 });
  const closed = once(f.client, "close");
  await f.read(12); f.client.send(VERSION); await f.read(2); f.client.send(Buffer.from([1])); await f.read(4); f.client.send(Buffer.from([1]));
  assert.equal((await closed)[0], 1008); await assert.rejects(f.handle.ready, /rfb_handshake_failed/);
});
test("RFB rejects invalid transport configuration before any TCP connection", () => {
  for (const port of [0, 22, 4310, 65536, NaN]) assert.throws(() => bridgeRfb({}, { port, password: PASSWORD }), /invalid_vnc_transport/);
  assert.throws(() => bridgeRfb({}, { port: 5950, password: "wrong" }), /invalid_vnc_transport/);
});
