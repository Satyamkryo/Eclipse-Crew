import http from "node:http";
import dns from "node:dns/promises";
import { once } from "node:events";
import { z } from "zod";
import { createAuthenticator } from "./controller.mjs";
import { inspectAgent, launchAgent } from "./agent-store.mjs";
import { UUID_PATTERN } from "./controller-schema.mjs";

// File listener (port 4311): owner uploads into inbox/, and listing/reading of the agent's outbox/. Same network,
// secret and source checks as the controller, but its own timeouts: the controller's JSON server is capped at
// 16 KiB and 5 s and must stay that way.
export const MAX_UPLOAD_BYTES = 1024 ** 3;
export const MAX_ACTIVE_UPLOADS = 2;
export const MAX_ACTIVE_READS = 4;
export const MAX_ACTIVE_TOOLS = 4;
const MAX_TOOL_OUTPUT = 9 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 4 * 1024 ** 2;
const WRITER = "/opt/eclipse/desktop/inbox-writer.mjs";
const READER = "/opt/eclipse/desktop/outbox-reader.mjs";
const TOOLS = "/opt/eclipse/desktop/file-tools.mjs";
const CHECKPOINTS = "/opt/eclipse/desktop/checkpoint-tools.mjs";
const CHECKPOINT_RESTORE = "/opt/eclipse/desktop/checkpoint-restore.mjs";
const CHECKPOINT_AREAS = new Set(["inbox", "work", "downloads", "outbox"]);
const IDLE_MS = 30_000;
const MAX_JSON = 256 * 1024;
const STATUS = { file_too_large: 413, type_blocked: 415, name_invalid: 400, empty_file: 400, incomplete_upload: 400, upload_busy: 409,
  agent_unavailable: 404, invalid_upload: 400, auth_failed: 401, source_denied: 403, not_found: 404, method_not_allowed: 405, invalid_content_type: 415, upload_failed: 500,
  file_not_found: 404, file_changed: 409, scan_failed: 500, download_failed: 500, invalid_request: 400,
  unsupported_type: 415, no_text_layer: 422, document_unreadable: 422, invalid_offset: 400, deliver_failed: 500,
  content_changed: 409, too_many_files: 422, scan_limit: 504, path_invalid: 400, target_blocked: 409, restore_failed: 500,
  no_match: 422, index_failed: 500 };
const reply = (res, status, value) => {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Connection: "close" });
  res.end(JSON.stringify(value));
};
const refuse = (res, code) => reply(res, STATUS[code] ?? 500, { outcome: "error", code: STATUS[code] ? code : "upload_failed" });
const drain = (req, ms = 60_000) => new Promise((resolve) => {
  if (req.complete || req.destroyed) return resolve();
  const timer = setTimeout(resolve, ms);
  const done = () => { clearTimeout(timer); resolve(); };
  req.once("end", done); req.once("close", done); req.once("error", done); req.resume();
});
const plainName = z.string().min(1).max(255).refine((value) => !/[\u0000-\u001f\u007f-\u009f/\\]/.test(value) && !value.startsWith("."));
const ListRequest = z.object({ known: z.array(z.tuple([plainName, z.number().int().min(0)])).max(1000) }).strict();
const ToolRequests = {
  list: z.object({}).strict(),
  read: z.object({ name: plainName, offset: z.number().int().min(0).max(5_000_000).optional() }).strict(),
  deliver: z.object({ from: z.enum(["downloads", "work"]), name: plainName }).strict(),
  // TASK-082. Indexing is launched by this server after an upload; only search is reachable over HTTP.
  index: z.object({ name: plainName }).strict(),
  search: z.object({ name: plainName, query: z.string().min(1).max(200).refine((value) => !/[\u0000-\u001f\u007f-\u009f]/.test(value)) }).strict(),
  // TASK-032: file manifest and file bytes for per-step checkpoints (the app stores the bytes by hash).
  "checkpoint/manifest": z.object({}).strict(),
  "checkpoint/blob": z.object({ area: z.enum(["inbox", "work", "downloads", "outbox"]), path: z.string().min(1).max(1024), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  // TASK-043: move a file that did not exist at the rewound checkpoint aside. Never deletes it.
  "checkpoint/aside": z.object({ area: z.enum(["inbox", "work", "downloads", "outbox"]), path: z.string().min(1).max(1024), bucket: z.string().regex(UUID_PATTERN) }).strict(),
};
const ReadRequest = z.object({ name: plainName, sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().min(1).max(MAX_UPLOAD_BYTES) }).strict();
// Waits for the response to drain or close, and removes both listeners either way.
const drained = (res) => new Promise((resolve) => {
  const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
  res.once("drain", done); res.once("close", done);
});
async function readJson(req) {
  const declared = req.headers["content-length"];
  if (typeof declared !== "string" || !/^[0-9]{1,7}$/.test(declared) || Number(declared) > MAX_JSON) return undefined;
  const chunks = []; let size = 0; const timer = setTimeout(() => req.destroy(), 5000);
  try { for await (const chunk of req) { size += chunk.length; if (size > MAX_JSON) return undefined; chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return undefined; } finally { clearTimeout(timer); }
}
function parseResult(code, text) {
  let value; try { value = JSON.parse(text.trim().split("\n").pop() ?? ""); } catch { return { code: "upload_failed" }; }
  if (code === 0 && value && typeof value.storedName === "string" && Number.isSafeInteger(value.size) && typeof value.kind === "string" && /^[0-9a-f]{64}$/.test(value.sha256 ?? ""))
    return { result: { storedName: value.storedName, size: value.size, kind: value.kind, sha256: value.sha256 } };
  return { code: typeof value?.error === "string" && STATUS[value.error] ? value.error : "upload_failed" };
}

export function createFileServer(secret, { resolveApp = () => dns.lookup("app", { all: true }), inspect = inspectAgent, launch = launchAgent,
  writerArgs = ["/usr/bin/timeout", "--kill-after=2s", "900s", "node", WRITER], readerArgs = ["/usr/bin/timeout", "--kill-after=2s", "900s", "node", READER],
  toolArgs = ["/usr/bin/timeout", "--kill-after=2s", "60s", "node", "--max-old-space-size=768", TOOLS],
  indexArgs = ["/usr/bin/timeout", "--kill-after=2s", "180s", "node", "--max-old-space-size=1024", TOOLS],
  checkpointArgs = ["/usr/bin/timeout", "--kill-after=2s", "30s", "node", "--max-old-space-size=512", CHECKPOINTS],
  restoreArgs = ["/usr/bin/timeout", "--kill-after=2s", "60s", "node", "--max-old-space-size=512", CHECKPOINT_RESTORE], idleMs = IDLE_MS } = {}) {
  const authenticate = createAuthenticator(secret, resolveApp);
  const active = new Set(); let reads = 0; let tools = 0;
  // TASK-082. A best-effort warm-up index after an inbox upload: at most one per agent and two in total. Its failure
  // never fails the upload; search builds the index itself when it is missing.
  const indexing = new Set(); let indexingTotal = 0;
  const startIndex = (record, name) => {
    const agentId = record?.agentId;
    if (!agentId || indexing.has(agentId) || indexingTotal >= 2) return;
    indexing.add(agentId); indexingTotal += 1;
    let settled = false;
    const done = () => { if (settled) return; settled = true; indexing.delete(agentId); indexingTotal -= 1; };
    try {
      const child = launch(record, [...indexArgs, "index", JSON.stringify({ name })], { stdio: ["ignore", "ignore", "ignore"] });
      child.once("close", done);
      child.once("error", done);
    } catch { done(); }
  };

  async function upload(req, res, ownerId, agentId) {
    let agentKey = null;
    try {
      if ((req.headers["content-type"] ?? "").split(";")[0].trim() !== "application/octet-stream") return refuse(res, "invalid_content_type");
      const length = req.headers["content-length"]; const maximum = req.headers["x-max-bytes"]; const rawName = req.headers["x-file-name"];
      if (typeof length !== "string" || !/^[0-9]{1,13}$/.test(length) || typeof maximum !== "string" || !/^[0-9]{1,13}$/.test(maximum) ||
        typeof rawName !== "string" || rawName.length > 3072) { await drain(req, 5000); return refuse(res, "invalid_upload"); }
      const expected = Number(length); const limit = Number(maximum);
      let name; try { name = decodeURIComponent(rawName); } catch { await drain(req, 5000); return refuse(res, "name_invalid"); }
      if (limit < 1 || limit > MAX_UPLOAD_BYTES) { await drain(req, 5000); return refuse(res, "invalid_upload"); }
      if (expected < 1) return refuse(res, "empty_file");
      if (expected > limit) return refuse(res, "file_too_large");
      if (active.has(agentId) || active.size >= MAX_ACTIVE_UPLOADS) { await drain(req); return refuse(res, "upload_busy"); }
      active.add(agentId); agentKey = agentId;
      let record;
      try { record = await inspect(ownerId, agentId); } catch { await drain(req); return refuse(res, "agent_unavailable"); }
      req.socket.setTimeout(idleMs, () => req.destroy());
      const child = launch(record, [...writerArgs, JSON.stringify({ name, expected, limit })], { stdio: ["pipe", "pipe", "ignore"] });
      let output = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", (data) => { if (output.length < 4096) output += data; });
      const closed = new Promise((resolve) => { child.once("close", (code) => resolve(code)); child.once("error", () => resolve(-1)); });
      let broken = false; child.stdin.on("error", () => { broken = true; });
      try {
        // Keep reading the body even after the writer stops, so the sender gets a clean answer instead of a reset.
        for await (const chunk of req) {
          if (broken || child.stdin.destroyed || !child.stdin.writable) continue;
          if (!child.stdin.write(chunk)) await Promise.race([once(child.stdin, "drain").catch(() => {}), closed]);
        }
      } catch { /* client gone or idle: ending stdin short makes the writer discard its partial file */ }
      req.socket.setTimeout(0);
      try { child.stdin.end(); } catch { /* already closed */ }
      const code = await closed;
      const parsed = parseResult(code, output);
      if (parsed.result) {
        if (parsed.result.kind === "text" || parsed.result.kind === "pdf" || parsed.result.kind === "document") startIndex(record, parsed.result.storedName);
        return reply(res, 200, { outcome: "ok", result: parsed.result });
      }
      return refuse(res, parsed.code);
    } finally { if (agentKey) active.delete(agentKey); }
  }

  async function outbox(req, res, ownerId, agentId, action) {
    if ((req.headers["content-type"] ?? "").split(";")[0].trim() !== "application/json") return refuse(res, "invalid_content_type");
    const raw = await readJson(req);
    const parsed = (action === "list" ? ListRequest : ReadRequest).safeParse(raw);
    if (!parsed.success) return refuse(res, "invalid_request");
    if (reads >= MAX_ACTIVE_READS) return refuse(res, "upload_busy");
    reads += 1;
    try {
      let record;
      try { record = await inspect(ownerId, agentId); } catch { return refuse(res, "agent_unavailable"); }
      const child = launch(record, [...readerArgs, action, JSON.stringify(parsed.data)], { stdio: ["ignore", "pipe", "ignore"] });
      const closed = new Promise((resolve) => { child.once("close", (code) => resolve(code)); child.once("error", () => resolve(-1)); });
      if (action === "list") {
        let output = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", (data) => { if (output.length < MAX_JSON) output += data; });
        const code = await closed; let value; try { value = JSON.parse(output.trim().split("\n").pop() ?? ""); } catch { value = undefined; }
        if (code === 0 && Array.isArray(value?.files) && Number.isSafeInteger(value.pending)) return reply(res, 200, { outcome: "ok", result: { files: value.files, pending: value.pending } });
        return refuse(res, typeof value?.error === "string" && STATUS[value.error] ? value.error : "scan_failed");
      }
      // read: one JSON header line ({"size":N} or {"error":code}), then exactly N bytes.
      let header = Buffer.alloc(0); let sent = 0; let size = 0; let started = false;
      res.on("close", () => { if (!child.stdout.destroyed) child.stdout.destroy(); });
      res.setTimeout(idleMs, () => res.destroy());
      for await (const chunk of child.stdout) {
        let body = chunk;
        if (!started) {
          header = Buffer.concat([header, chunk]);
          const end = header.indexOf(10);
          if (end < 0) { if (header.length > 512) break; continue; }
          let line; try { line = JSON.parse(header.subarray(0, end).toString("utf8")); } catch { line = undefined; }
          if (Number.isSafeInteger(line?.size) && line.size === parsed.data.size) {
            started = true; size = line.size; body = header.subarray(end + 1);
            res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(size), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
          } else return refuse(res, typeof line?.error === "string" && STATUS[line.error] ? line.error : "download_failed");
        }
        if (sent + body.length > size) body = body.subarray(0, size - sent);
        if (res.destroyed) return;
        if (body.length && !res.write(body)) await drained(res);
        sent += body.length;
        if (res.destroyed) return;
      }
      await closed;
      if (!started) return refuse(res, "download_failed");
      if (sent !== size) return res.destroy();
      return res.end();
    } finally { reads -= 1; }
  }

  // TASK-067: list the agent's files, read text out of an inbox attachment, copy a download or work file to outbox/.
  // The tool runs as the agent's own Linux user; this listener only validates the request and relays one JSON line.
  async function fileTool(req, res, ownerId, agentId, action) {
    if ((req.headers["content-type"] ?? "").split(";")[0].trim() !== "application/json") return refuse(res, "invalid_content_type");
    const parsed = ToolRequests[action].safeParse(await readJson(req));
    if (!parsed.success) return refuse(res, "invalid_request");
    if (tools >= MAX_ACTIVE_TOOLS) return refuse(res, "upload_busy");
    tools += 1;
    try {
      let record;
      try { record = await inspect(ownerId, agentId); } catch { return refuse(res, "agent_unavailable"); }
      const argv = action === "checkpoint/aside" ? [...restoreArgs, "aside"]
        : action.startsWith("checkpoint/") ? [...checkpointArgs, action.slice("checkpoint/".length)]
        : action === "search" ? [...indexArgs, action] : [...toolArgs, action];
      const child = launch(record, [...argv, JSON.stringify(parsed.data)], { stdio: ["ignore", "pipe", "ignore"] });
      const closed = new Promise((resolve) => { child.once("close", (code) => resolve(code)); child.once("error", () => resolve(-1)); });
      let output = ""; let over = false; child.stdout.setEncoding("utf8");
      child.stdout.on("data", (data) => { if (output.length + data.length > MAX_TOOL_OUTPUT) { over = true; child.kill("SIGKILL"); } else output += data; });
      const code = await closed; let value; try { value = JSON.parse(output.trim().split("\n").pop() ?? ""); } catch { value = undefined; }
      if (code === 0 && !over && value && typeof value.result === "object" && value.result !== null) return reply(res, 200, { outcome: "ok", result: value.result });
      return refuse(res, typeof value?.error === "string" && STATUS[value.error] ? value.error : "scan_failed");
    } finally { tools -= 1; }
  }

  // TASK-043: stream one saved file into the agent's own area. The bytes are re-hashed by the tool before the rename.
  async function checkpointPut(req, res, ownerId, agentId) {
    if ((req.headers["content-type"] ?? "").split(";")[0].trim() !== "application/octet-stream") return refuse(res, "invalid_content_type");
    const length = req.headers["content-length"]; const area = req.headers["x-area"]; const rawPath = req.headers["x-path"]; const sha256 = req.headers["x-sha256"];
    if (typeof length !== "string" || !/^\d{1,8}$/.test(length) || typeof area !== "string" || !CHECKPOINT_AREAS.has(area) ||
      typeof rawPath !== "string" || rawPath.length > 3072 || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
      await drain(req, 5000); return refuse(res, "invalid_request");
    }
    const size = Number(length);
    if (size > MAX_CHECKPOINT_BYTES) { await drain(req); return refuse(res, "file_too_large"); }
    let rel; try { rel = decodeURIComponent(rawPath); } catch { await drain(req, 5000); return refuse(res, "invalid_request"); }
    if (!rel || rel.startsWith("/") || rel.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
      await drain(req, 5000); return refuse(res, "invalid_request");
    }
    if (tools >= MAX_ACTIVE_TOOLS) { await drain(req); return refuse(res, "upload_busy"); }
    tools += 1;
    try {
      let record;
      try { record = await inspect(ownerId, agentId); } catch { await drain(req); return refuse(res, "agent_unavailable"); }
      req.socket.setTimeout(idleMs, () => req.destroy());
      const child = launch(record, [...restoreArgs, "put", JSON.stringify({ area, path: rel, sha256, size })], { stdio: ["pipe", "pipe", "ignore"] });
      let output = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", (data) => { if (output.length < 4096) output += data; });
      const closed = new Promise((resolve) => { child.once("close", (code) => resolve(code)); child.once("error", () => resolve(-1)); });
      let broken = false; child.stdin.on("error", () => { broken = true; });
      try {
        for await (const chunk of req) {
          if (broken || child.stdin.destroyed || !child.stdin.writable) continue;
          if (!child.stdin.write(chunk)) await Promise.race([once(child.stdin, "drain").catch(() => {}), closed]);
        }
      } catch { /* client gone: an ended stdin leaves a short body, which the tool refuses and removes */ }
      req.socket.setTimeout(0);
      try { child.stdin.end(); } catch { /* already closed */ }
      const code = await closed;
      let value; try { value = JSON.parse(output.trim().split("\n").pop() ?? ""); } catch { value = undefined; }
      if (code === 0 && value && typeof value.result === "object" && value.result !== null) return reply(res, 200, { outcome: "ok", result: value.result });
      return refuse(res, typeof value?.error === "string" && STATUS[value.error] ? value.error : "restore_failed");
    } finally { tools -= 1; }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const denied = await authenticate(req);
      if (denied) return refuse(res, denied);
      if (req.method !== "POST") return refuse(res, "method_not_allowed");
      const match = /^\/v1\/owners\/([^/]+)\/agents\/([^/]+)\/(inbox|outbox\/list|outbox\/read|files\/list|files\/read|files\/deliver|files\/search|checkpoint\/manifest|checkpoint\/blob|checkpoint\/put|checkpoint\/aside)$/.exec(req.url ?? "");
      if (!match || !UUID_PATTERN.test(match[1]) || !UUID_PATTERN.test(match[2])) return refuse(res, "not_found");
      if (match[3] === "inbox") return await upload(req, res, match[1], match[2]);
      if (match[3] === "checkpoint/put") return await checkpointPut(req, res, match[1], match[2]);
      if (match[3].startsWith("files/")) return await fileTool(req, res, match[1], match[2], match[3].slice("files/".length));
      if (match[3].startsWith("checkpoint/")) return await fileTool(req, res, match[1], match[2], match[3]);
      return await outbox(req, res, match[1], match[2], match[3].slice("outbox/".length));
    } catch { refuse(res, "upload_failed"); }
  });
  server.maxConnections = 12; server.headersTimeout = 5000; server.requestTimeout = 16 * 60_000; server.keepAliveTimeout = 1000;
  return server;
}
