export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export async function writeFramed(writable, message) {
  const body = Buffer.from(JSON.stringify(message));
  if (!body.length || body.length > MAX_MESSAGE_BYTES) throw Error("message_too_large");
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
  await new Promise((resolve, reject) => writable.write(Buffer.concat([header, body]), (e) => e ? reject(e) : resolve()));
}
export async function* readFramed(readable) {
  const header = Buffer.alloc(4); let headerAt = 0, body = null, bodyAt = 0;
  for await (const raw of readable) {
    const chunk = Buffer.from(raw); let at = 0;
    while (at < chunk.length) {
      if (!body) {
        const count = Math.min(4 - headerAt, chunk.length - at); chunk.copy(header, headerAt, at, at + count); headerAt += count; at += count;
        if (headerAt < 4) continue;
        const length = header.readUInt32BE(); if (!length || length > MAX_MESSAGE_BYTES) throw Error("message_too_large");
        body = Buffer.alloc(length); bodyAt = 0;
      }
      const count = Math.min(body.length - bodyAt, chunk.length - at); chunk.copy(body, bodyAt, at, at + count); bodyAt += count; at += count;
      if (bodyAt === body.length) { const value = JSON.parse(body.toString("utf8")); body = null; headerAt = 0; yield value; }
    }
  }
  if (body || headerAt) throw Error("truncated_frame");
}
export function createChannel(readable, writable, { onEvent = () => {}, maxPending = 8 } = {}) {
  const pending = new Map(); let closed = false;
  function close(code = "channel_closed") {
    if (closed) return; closed = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Object.assign(Error(code), { code })); }
    pending.clear();
  }
  const done = (async () => {
    try {
      for await (const message of readFramed(readable)) {
        if (!message || typeof message !== "object" || Array.isArray(message)) throw Error("invalid_frame");
        if (message.state) { await onEvent(message); continue; }
        if (typeof message.requestId !== "string" || message.requestId.length > 64) throw Error("invalid_frame");
        const item = pending.get(message.requestId); if (!item) continue;
        pending.delete(message.requestId); clearTimeout(item.timer);
        if (message.error) item.reject(Object.assign(Error("worker_operation_failed"), { code: /^[a-z_]{1,64}$/.test(message.error.code) ? message.error.code : "operation_failed" }));
        else item.resolve(message.result);
      }
    } catch { close("channel_closed"); } finally { close(); }
  })();
  return { done, close, send(message, { timeoutMs = 5000 } = {}) {
    if (closed) return Promise.reject(Object.assign(Error("channel_closed"), { code: "channel_closed" }));
    const id = message.requestId;
    if (typeof id !== "string" || id.length > 64 || pending.has(id) || pending.size >= maxPending) return Promise.reject(Object.assign(Error("channel_busy"), { code: "channel_busy" }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(Error("uncertain_outcome"), { code: "uncertain_outcome" })); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      writeFramed(writable, message).catch(() => { const item = pending.get(id); if (item) { clearTimeout(item.timer); pending.delete(id); item.reject(Object.assign(Error("channel_closed"), { code: "channel_closed" })); } });
    });
  } };
}
