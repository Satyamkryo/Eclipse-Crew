import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createFileServer } from "../docker/desktop/file-server.mjs";

const SECRET = "c".repeat(64);
const OWNER = randomUUID(); const AGENT = randomUUID(); const PEER = randomUUID(); const THIRD = randomUUID();
const BUCKET = randomUUID();
const WRITER = pathToFileURL(path.resolve("docker/desktop/inbox-writer.mjs")).href;
const READER = pathToFileURL(path.resolve("docker/desktop/outbox-reader.mjs")).href;
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
const png = (size) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(size - 8)]);

// The real server and the real writer; only the "run as the agent's Linux user" step is replaced by a plain child process.
async function start(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "files-"));
  const inboxes = new Map(); const outboxes = new Map();
  for (const id of [AGENT, PEER, THIRD]) {
    const dir = path.join(root, id); await mkdir(dir, { mode: 0o700 }); inboxes.set(id, dir);
    const out = path.join(root, `${id}-outbox`); await mkdir(out, { mode: 0o700 }); outboxes.set(id, out);
  }
  const readerWrapper = path.join(root, "run-reader.mjs");
  await writeFile(readerWrapper, `import { listOutbox, readOutbox } from ${JSON.stringify(READER)};
const [mode, raw] = [process.argv[2], process.argv[3]]; const params = JSON.parse(raw);
const out = (value) => new Promise((resolve, reject) => process.stdout.write(value, (error) => error ? reject(error) : resolve()));
let started = false;
try {
  if (mode === "list") await out(JSON.stringify(await listOutbox({ outbox: process.env.OUTBOX, known: params.known })) + "\\n");
  else await readOutbox({ outbox: process.env.OUTBOX, name: params.name, sha256: params.sha256, size: params.size, write: (value) => { started = true; return out(value); } });
} catch (error) { if (!started) await out(JSON.stringify({ error: error.code ?? "scan_failed" }) + "\\n"); process.exitCode = 3; }`);
  const wrapper = path.join(root, "run-writer.mjs");
  await writeFile(wrapper, `import { writeInbox } from ${JSON.stringify(WRITER)};
const params = JSON.parse(process.argv[2]);
try { process.stdout.write(JSON.stringify(await writeInbox({ stream: process.stdin, inbox: process.env.INBOX, rawName: params.name, expected: params.expected, limit: params.limit, idleMs: 3000 })) + "\\n"); }
catch (error) { process.stdout.write(JSON.stringify({ error: error.code ?? "upload_failed" }) + "\\n"); process.exitCode = 3; }`);
  const launches = [];
  const server = createFileServer(SECRET, {
    resolveApp: async () => [{ address: "127.0.0.1", family: 4 }],
    inspect: async (ownerId, agentId) => { if (ownerId !== OWNER || !inboxes.has(agentId)) throw new Error("agent_unavailable"); return { agentId, ownerId, home: root }; },
    launch: (record, argv, spawnOptions) => { launches.push(argv); return spawn(process.execPath, argv.slice(1), { ...spawnOptions, env: { ...process.env, INBOX: inboxes.get(record.agentId), OUTBOX: outboxes.get(record.agentId) } }); },
    writerArgs: ["unused", wrapper], readerArgs: ["unused", readerWrapper], idleMs: 2500, ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { port: server.address().port, inboxes, outboxes, launches, root };
}
function post(port, { owner = OWNER, agent = AGENT, body, name = "photo.png", limit = 16 * 1024 * 1024, headers = {}, length, path: url } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method: "POST", path: url ?? `/v1/owners/${owner}/agents/${agent}/inbox`,
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/octet-stream", "Content-Length": String(length ?? body.length),
        "X-File-Name": encodeURIComponent(name), "X-Max-Bytes": String(limit), ...headers } }, (response) => {
      let text = ""; response.setEncoding("utf8"); response.on("data", (data) => { text += data; });
      response.on("end", () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

test("a 12 MB upload streams through and arrives byte-identical", async (t) => {
  const { port, inboxes } = await start(t); const body = png(12 * 1024 * 1024);
  const response = await post(port, { body });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { outcome: "ok", result: { storedName: "photo.png", size: body.length, kind: "image", sha256: sha(body) } });
  assert.equal(sha(await readFile(path.join(inboxes.get(AGENT), "photo.png"))), sha(body));
  assert.deepEqual(await readdir(inboxes.get(PEER)), [], "the other agent's inbox is untouched");
});

test("only the app with the secret is served, and only the exact request shape", async (t) => {
  const { port } = await start(t); const body = png(100);
  assert.equal((await post(port, { body, headers: { Authorization: "Bearer nope" } })).status, 401);
  assert.equal((await post(port, { body, headers: { Authorization: `Bearer ${"d".repeat(64)}` } })).body.code, "auth_failed");
  assert.equal((await post(port, { body, headers: { Origin: "http://evil.example" } })).status, 403);
  assert.equal((await post(port, { body, headers: { "Content-Type": "application/json" } })).status, 415);
  assert.equal((await post(port, { body, path: `/v1/owners/${OWNER}/agents/not-a-uuid/inbox` })).status, 404);
  assert.equal((await post(port, { body, path: `/v1/owners/${OWNER}/agents/${AGENT}/other` })).status, 404);
  assert.equal((await post(port, { body, headers: { "X-File-Name": "%E0%A4%A" } })).body.code, "name_invalid");
  assert.equal((await post(port, { body, limit: 10 })).body.code, "file_too_large");
  assert.equal((await post(port, { body, limit: 2 * 1024 ** 3 })).body.code, "invalid_upload");
  assert.equal((await post(port, { body: Buffer.alloc(0) })).body.code, "empty_file");
  const unknownAgent = await post(port, { body, agent: randomUUID() });
  assert.deepEqual(unknownAgent.body, { outcome: "error", code: "agent_unavailable" }); assert.equal(unknownAgent.status, 404);
  assert.equal((await post(port, { body, owner: randomUUID() })).status, 404);
  const wrongSource = await start(t, { resolveApp: async () => [{ address: "10.9.9.9", family: 4 }] });
  assert.equal((await post(wrongSource.port, { body })).body.code, "source_denied");
});

test("a blocked type is answered after the whole body is read, and nothing is stored", async (t) => {
  const { port, inboxes } = await start(t);
  const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), randomBytes(3 * 1024 * 1024)]);
  const response = await post(port, { body: elf });
  assert.deepEqual(response.body, { outcome: "error", code: "type_blocked" }); assert.equal(response.status, 415);
  assert.equal((await post(port, { body: png(50), name: "run.exe" })).body.code, "type_blocked");
  assert.deepEqual(await readdir(inboxes.get(AGENT)), []);
});

test("a body shorter than declared is refused and leaves no file; the next upload works", async (t) => {
  const { port, inboxes } = await start(t); const body = png(2 * 1024 * 1024);
  await new Promise((resolve) => {
    const request = http.request({ host: "127.0.0.1", port, method: "POST", path: `/v1/owners/${OWNER}/agents/${AGENT}/inbox`,
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/octet-stream", "Content-Length": String(body.length), "X-File-Name": "cut.png", "X-Max-Bytes": "16777216" } });
    request.on("error", () => resolve()); request.on("close", resolve);
    request.write(body.subarray(0, 1024 * 1024)); setTimeout(() => request.destroy(), 150);
  });
  // The slot frees only after the writer has cleaned up, so a successful next upload proves the cleanup finished.
  let next;
  for (let attempt = 0; attempt < 50; attempt++) {
    next = await post(port, { body: png(1000), name: "after.png" });
    if (next.status !== 409) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(next.status, 200);
  assert.deepEqual(await readdir(inboxes.get(AGENT)), ["after.png"]);
});

test("one upload per agent at a time", async (t) => {
  const { port } = await start(t);
  const slow = (agent) => new Promise((resolve) => {
    const request = http.request({ host: "127.0.0.1", port, method: "POST", path: `/v1/owners/${OWNER}/agents/${agent}/inbox`,
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/octet-stream", "Content-Length": "5000", "X-File-Name": "slow.png", "X-Max-Bytes": "1000000" } }, (response) => {
      let text = ""; response.on("data", (data) => { text += data; }); response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    });
    request.write(png(2500));
    setTimeout(() => request.end(png(2500)), 1200);
  });
  const first = slow(AGENT);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const second = await post(port, { body: png(100), name: "again.png" });
  assert.deepEqual(second.body, { outcome: "error", code: "upload_busy" }); assert.equal(second.status, 409);
  assert.equal((await first).status, 200);
  assert.equal((await post(port, { body: png(100), name: "now.png" })).status, 200);
});

test("a stack-wide limit of two uploads is enforced", async (t) => {
  const { port } = await start(t);
  const started = [AGENT, PEER].map((agent) => new Promise((resolve) => {
    const request = http.request({ host: "127.0.0.1", port, method: "POST", path: `/v1/owners/${OWNER}/agents/${agent}/inbox`,
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/octet-stream", "Content-Length": "4000", "X-File-Name": "hold.png", "X-Max-Bytes": "1000000" } }, (response) => {
      response.resume(); response.on("end", () => resolve(response.statusCode));
    });
    request.write(png(2000)); setTimeout(() => request.end(png(2000)), 1200);
  }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const third = await post(port, { body: png(100), name: "third.png", agent: THIRD });
  assert.equal(third.body.code, "upload_busy", "a third agent has to wait while two uploads run");
  assert.deepEqual(await Promise.all(started), [200, 200]);
});

function postJson(port, action, body, { agent = AGENT, headers = {}, raw } = {}) {
  const text = raw ?? JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method: "POST", path: `/v1/owners/${OWNER}/agents/${agent}/outbox/${action}`,
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(text)), ...headers } }, (response) => {
      const chunks = []; response.on("data", (data) => chunks.push(data));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks), complete: response.complete }));
      response.on("error", reject);
    });
    request.on("error", reject); request.end(text);
  });
}
const settle = async (outbox, name, content) => { await writeFile(path.join(outbox, name), content); const old = new Date(Date.now() - 60_000); await utimes(path.join(outbox, name), old, old); };

test("the outbox list returns only new files, skips known ones, and is scoped to one agent", async (t) => {
  const { port, outboxes } = await start(t); const picture = png(4000);
  await settle(outboxes.get(AGENT), "chart.png", picture); await settle(outboxes.get(AGENT), "notes.txt", "hello\n"); await settle(outboxes.get(PEER), "peer.txt", "peer only");
  const first = await postJson(port, "list", { known: [] });
  assert.equal(first.status, 200);
  const listed = JSON.parse(first.body.toString()).result;
  assert.deepEqual(listed.files.map((file) => file.name).sort(), ["chart.png", "notes.txt"]);
  assert.equal(listed.files.find((file) => file.name === "chart.png").sha256, sha(picture));
  const again = JSON.parse((await postJson(port, "list", { known: listed.files.map((file) => [file.name, file.size]) })).body.toString()).result;
  assert.deepEqual(again, { files: [], pending: 0 });
  assert.deepEqual(JSON.parse((await postJson(port, "list", { known: [] }, { agent: PEER })).body.toString()).result.files.map((file) => file.name), ["peer.txt"]);
});

test("a download streams exactly the carded bytes with an exact length", async (t) => {
  const { port, outboxes } = await start(t); const body = png(12 * 1024 * 1024);
  await settle(outboxes.get(AGENT), "big.png", body);
  const response = await postJson(port, "read", { name: "big.png", sha256: sha(body), size: body.length });
  assert.equal(response.status, 200); assert.equal(response.headers["content-length"], String(body.length));
  assert.equal(response.headers["content-type"], "application/octet-stream"); assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(sha(response.body), sha(body)); assert.equal(response.complete, true);
});

test("a changed, missing, foreign or malformed download request is refused with a safe JSON code and no file bytes", async (t) => {
  const { port, outboxes } = await start(t); const body = Buffer.from("original text content\n");
  await settle(outboxes.get(AGENT), "doc.txt", body); await settle(outboxes.get(PEER), "peer.txt", "peer secret");
  const ask = async (payload, options) => { const response = await postJson(port, "read", payload, options); return { status: response.status, json: JSON.parse(response.body.toString()) }; };
  await settle(outboxes.get(AGENT), "doc.txt", "edited text content!\n");
  assert.deepEqual(await ask({ name: "doc.txt", sha256: sha(body), size: body.length }), { status: 409, json: { outcome: "error", code: "file_changed" } });
  assert.deepEqual(await ask({ name: "nothing.txt", sha256: sha(body), size: 5 }), { status: 404, json: { outcome: "error", code: "file_not_found" } });
  assert.deepEqual(await ask({ name: "peer.txt", sha256: sha("peer secret"), size: 11 }), { status: 404, json: { outcome: "error", code: "file_not_found" } }, "another agent's file is not reachable");
  for (const bad of [{ name: "../peer.txt", sha256: sha("x"), size: 1 }, { name: "a/b", sha256: sha("x"), size: 1 }, { name: ".hidden", sha256: sha("x"), size: 1 }, { name: "a", sha256: "xyz", size: 1 }, { name: "a", sha256: sha("x"), size: 0 }, { name: "a", sha256: sha("x"), size: 1, extra: 1 }])
    assert.deepEqual(await ask(bad), { status: 400, json: { outcome: "error", code: "invalid_request" } }, JSON.stringify(bad));
  assert.equal((await postJson(port, "read", undefined, { raw: "not json" })).status, 400);
  assert.equal((await postJson(port, "list", { known: [] }, { headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await postJson(port, "list", { known: [] }, { agent: randomUUID() })).status, 404);
  assert.equal((await postJson(port, "read", { name: "doc.txt", sha256: sha(body), size: 5 }, { headers: { Authorization: "Bearer nope" } })).status, 401);
});

test("a download the browser abandons frees its slot", async (t) => {
  const { port, outboxes } = await start(t); const body = png(16 * 1024 * 1024);
  await settle(outboxes.get(AGENT), "big.png", body);
  await new Promise((resolve) => {
    const text = JSON.stringify({ name: "big.png", sha256: sha(body), size: body.length });
    const request = http.request({ host: "127.0.0.1", port, method: "POST", path: `/v1/owners/${OWNER}/agents/${AGENT}/outbox/read`,
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(text)) } }, (response) => {
      response.once("data", () => { request.destroy(); resolve(); });
    });
    request.on("error", () => {}); request.end(text);
  });
  for (let n = 0; n < 6; n++) {
    const response = await postJson(port, "read", { name: "big.png", sha256: sha(body), size: body.length });
    assert.equal(response.status, 200, `download ${n} after an abandoned one`);
  }
});

// ---- TASK-032: checkpoint routes. The real listener and the real tool code, against plain directories per agent. ----
const CHECKPOINT_TOOLS = pathToFileURL(path.resolve("docker/desktop/checkpoint-tools.mjs")).href;
const RESTORE_TOOLS = pathToFileURL(path.resolve("docker/desktop/checkpoint-restore.mjs")).href;
async function startCheckpoint(t) {
  const homes = await mkdtemp(path.join(tmpdir(), "cp-homes-"));
  const stub = path.join(homes, "run-checkpoint.mjs");
  await writeFile(stub, `import { scanManifest, readBlob } from ${JSON.stringify(CHECKPOINT_TOOLS)};
import path from "node:path";
const [mode, raw] = [process.argv[2], process.argv[3]]; const params = JSON.parse(raw);
const layout = Object.fromEntries(["inbox", "work", "downloads", "outbox"].map((area) => [area, { dir: path.join(process.env.AGENT_HOME, area) }]));
const out = (value) => new Promise((resolve, reject) => process.stdout.write(value, (error) => error ? reject(error) : resolve()));
try {
  const result = mode === "manifest" ? await scanManifest({ layout }) : await readBlob({ layout, area: params.area, rel: params.path, sha256: params.sha256 });
  await out(JSON.stringify({ result }) + "\\n");
} catch (error) { await out(JSON.stringify({ error: error.code ?? "scan_failed" }) + "\\n"); process.exitCode = 3; }`);
  const restoreStub = path.join(homes, "run-restore.mjs");
  await writeFile(restoreStub, `import { putFile, asideFile } from ${JSON.stringify(RESTORE_TOOLS)};
import path from "node:path";
const [mode, raw] = [process.argv[2], process.argv[3]]; const params = JSON.parse(raw);
const layout = Object.fromEntries(["inbox", "work", "downloads", "outbox"].map((area) => [area, { dir: path.join(process.env.AGENT_HOME, area) }]));
const out = (value) => new Promise((resolve, reject) => process.stdout.write(value, (error) => error ? reject(error) : resolve()));
try {
  const result = mode === "put"
    ? await putFile({ layout, area: params.area, rel: params.path, sha256: params.sha256, size: params.size, read: process.stdin })
    : await asideFile({ layout, area: params.area, rel: params.path, bucket: params.bucket });
  await out(JSON.stringify({ result }) + "\\n");
} catch (error) { await out(JSON.stringify({ error: error.code ?? "scan_failed" }) + "\\n"); process.exitCode = 3; }`);
  for (const id of [AGENT, PEER]) await mkdir(path.join(homes, id, "work"), { recursive: true });
  const started = await start(t, {
    checkpointArgs: ["unused", stub], restoreArgs: ["unused", restoreStub],
    launch: (record, argv, spawnOptions) => spawn(process.execPath, argv.slice(1), { ...spawnOptions, env: { ...process.env, AGENT_HOME: path.join(homes, record.agentId) } }),
  });
  t.after(() => rm(homes, { recursive: true, force: true }));
  return { ...started, homes };
}
function putCheckpoint(port, { agent = AGENT, area = "work", path: rel = "a.txt", sha256 = sha("alpha"), body = Buffer.from("alpha"),
  headers = {}, contentType = "application/octet-stream", length, method = "POST" } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path: `/v1/owners/${OWNER}/agents/${agent}/checkpoint/put`,
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": contentType, "Content-Length": String(length ?? body.length),
        "X-Area": area, "X-Path": encodeURIComponent(rel), "X-Sha256": sha256, ...headers } }, (response) => {
      let text = ""; response.setEncoding("utf8"); response.on("data", (data) => { text += data; });
      response.on("end", () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }));
    });
    request.on("error", reject); request.end(body);
  });
}
function asideCheckpoint(port, body, { agent = AGENT } = {}) {
  return postCheckpoint(port, "aside", body, { agent });
}
function postCheckpoint(port, action, body, { agent = AGENT, headers = {}, raw, method = "POST" } = {}) {
  const text = raw ?? JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path: `/v1/owners/${OWNER}/agents/${agent}/checkpoint/${action}`,
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(text)), ...headers } }, (response) => {
      const chunks = []; response.on("data", (data) => chunks.push(data));
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || "null") }));
      response.on("error", reject);
    });
    request.on("error", reject); request.end(text);
  });
}

test("the checkpoint manifest and blob routes list and return one agent's files and nothing of its peer's", async (t) => {
  const { port, homes } = await startCheckpoint(t);
  await writeFile(path.join(homes, AGENT, "work", "a.txt"), "alpha");
  await writeFile(path.join(homes, PEER, "work", "secret.txt"), "peer secret");
  const listed = await postCheckpoint(port, "manifest", {});
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.result.entries, [{ area: "work", path: "a.txt", size: 5, sha256: sha("alpha"), restorable: true }]);
  const blob = await postCheckpoint(port, "blob", { area: "work", path: "a.txt", sha256: sha("alpha") });
  assert.equal(blob.status, 200);
  assert.equal(Buffer.from(blob.body.result.base64, "base64").toString(), "alpha");
  const peer = await postCheckpoint(port, "manifest", {}, { agent: PEER });
  assert.deepEqual(peer.body.result.entries.map((entry) => entry.path), ["secret.txt"]);
  const cross = await postCheckpoint(port, "blob", { area: "work", path: "secret.txt", sha256: sha("peer secret") });
  assert.deepEqual([cross.status, cross.body.code], [404, "file_not_found"], "an agent cannot name a file only its peer has");
});

test("checkpoint requests are validated and tool errors map to fixed codes", async (t) => {
  const { port, homes } = await startCheckpoint(t);
  await writeFile(path.join(homes, AGENT, "work", "a.txt"), "alpha");
  const hash = sha("alpha");
  for (const body of [{ extra: 1 }, { area: "work" }]) assert.equal((await postCheckpoint(port, "manifest", body)).status, 400);
  for (const body of [{ area: "home", path: "a.txt", sha256: hash }, { area: "work", path: "a.txt", sha256: "nope" }, { area: "work", path: "", sha256: hash },
    { area: "work", path: "a.txt", sha256: hash, extra: true }, { area: "work", path: "x".repeat(1025), sha256: hash }])
    assert.equal((await postCheckpoint(port, "blob", body)).status, 400, JSON.stringify(body).slice(0, 80));
  for (const rel of ["../a.txt", "/etc/passwd", "a/../a.txt"]) {
    const refused = await postCheckpoint(port, "blob", { area: "work", path: rel, sha256: hash });
    assert.deepEqual([refused.status, refused.body.code], [404, "file_not_found"], rel);
  }
  const changed = await postCheckpoint(port, "blob", { area: "work", path: "a.txt", sha256: sha("beta") });
  assert.deepEqual([changed.status, changed.body.code], [409, "content_changed"]);
  assert.equal((await postCheckpoint(port, "manifest", {}, { headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await postCheckpoint(port, "manifest", {}, { headers: { Authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await postCheckpoint(port, "manifest", {}, { method: "GET" })).status, 405);
  assert.equal((await postCheckpoint(port, "other", {})).status, 404);
});

// ---- TASK-043: the restore routes, with the real tool code against plain directories per agent. ----

test("checkpoint put writes one saved file as the agent's own user and never touches a peer", async (t) => {
  const { port, homes } = await startCheckpoint(t);
  const result = await putCheckpoint(port, { path: "notes/a.txt", body: Buffer.from("alpha") });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.result, { size: 5, sha256: sha("alpha") });
  assert.equal(await readFile(path.join(path.join(homes, AGENT), "work", "notes", "a.txt"), "utf8"), "alpha");
  await assert.rejects(() => readFile(path.join(path.join(homes, PEER), "work", "notes", "a.txt")), "a peer home is never written");
});

test("checkpoint put denies bad headers, escapes, oversized bodies and mismatched content", async (t) => {
  const { port, homes } = await startCheckpoint(t);
  assert.equal((await putCheckpoint(port, { area: "home" })).status, 400);
  assert.equal((await putCheckpoint(port, { sha256: "nope" })).status, 400);
  assert.equal((await putCheckpoint(port, { path: "../outside.txt" })).status, 400);
  assert.equal((await putCheckpoint(port, { path: ".hidden" })).status, 400);
  assert.equal((await putCheckpoint(port, { contentType: "application/json" })).status, 415);
  assert.equal((await putCheckpoint(port, { body: Buffer.from("alpha"), sha256: sha("beta") })).status, 409);
  const big = Buffer.alloc(4 * 1024 * 1024 + 1, 1);
  assert.equal((await putCheckpoint(port, { body: big, sha256: sha(big) })).status, 413);
  assert.deepEqual(await readdir(path.join(path.join(homes, AGENT), "work")), [], "nothing is left behind");
});

test("checkpoint aside moves a later file into the hidden bucket and never crosses agents", async (t) => {
  const { port, homes } = await startCheckpoint(t);
  await writeFile(path.join(path.join(homes, AGENT), "work", "later.txt"), "later");
  const result = await asideCheckpoint(port, { area: "work", path: "later.txt", bucket: BUCKET });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.result, { moved: true });
  await assert.rejects(() => readFile(path.join(path.join(homes, AGENT), "work", "later.txt")));
  assert.equal(await readFile(path.join(path.join(homes, AGENT), "work", ".rewound", BUCKET, "later.txt"), "utf8"), "later");
  const peer = await asideCheckpoint(port, { area: "work", path: "later.txt", bucket: BUCKET }, { agent: PEER });
  assert.deepEqual([peer.status, peer.body.code], [404, "file_not_found"]);
  assert.equal((await asideCheckpoint(port, { area: "work", path: "../x", bucket: BUCKET })).status, 400);
  assert.equal((await asideCheckpoint(port, { area: "work", path: "later.txt", bucket: "nope" })).status, 400);
});