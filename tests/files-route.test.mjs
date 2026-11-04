import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const unwrap = (module) => module.default ?? module;
const AGENT = randomUUID();
const OWNER = randomUUID();
const HASH = "a".repeat(64);

test("the upload route exposes only an authenticated POST and refuses anonymous requests with safe headers", async () => {
  const route = unwrap(await import("../app/api/agents/[agentId]/files/route.ts"));
  assert.equal(typeof route.POST, "function");
  for (const method of ["GET", "PUT", "PATCH", "DELETE"]) assert.equal(route[method], undefined, method);
  const response = await route.POST(new Request(`http://127.0.0.1:3000/api/agents/${AGENT}/files`, {
    method: "POST", headers: { "Content-Type": "application/octet-stream", "Content-Length": "3", "X-File-Name": "a.txt", Origin: "http://127.0.0.1:3000" }, body: "abc",
  }), { params: Promise.resolve({ agentId: AGENT }) });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
});

test("the proxy matcher skips only the exact upload path, so every other API route keeps its checks", async () => {
  const { config } = unwrap(await import("../proxy.ts"));
  assert.equal(config.matcher.length, 1);
  const matches = (pathname) => new RegExp(`^${config.matcher[0]}$`).test(pathname);
  assert.equal(matches(`/api/agents/${AGENT}/files`), false);
  for (const covered of [`/api/agents/${AGENT}/messages`, `/api/agents/${AGENT}`, `/api/agents/${AGENT}/files/extra`, `/api/agents/${AGENT}/filesx`, "/api/auth/login", "/", "/settings/account", "/api/models/test"])
    assert.equal(matches(covered), true, covered);
  assert.equal(matches("/_next/static/chunk.js"), false);
});

test("MAX_UPLOAD_MB defaults to 250, accepts whole numbers from 1 to 1024 and rejects everything else", async () => {
  const { requireMaxUploadBytes } = unwrap(await import("../lib/config/server.ts"));
  const mb = 1024 * 1024;
  for (const unset of [undefined, null, ""]) assert.equal(requireMaxUploadBytes(unset), 250 * mb);
  assert.equal(requireMaxUploadBytes("1"), mb);
  assert.equal(requireMaxUploadBytes("16"), 16 * mb);
  assert.equal(requireMaxUploadBytes("1024"), 1024 * mb);
  for (const bad of ["0", "-5", "1025", "2.5", "10MB", " 10", "1e3", "abc", "0100", 10, "99999"])
    assert.throws(() => requireMaxUploadBytes(bad), /MAX_UPLOAD_MB/, String(bad));
});

test("file cards need a plain name, a known kind, a real size and a SHA-256", async () => {
  const { chatCardSchema } = unwrap(await import("../lib/chat/schema.ts"));
  const card = { type: "file", direction: "inbox", name: "report (1).pdf", size: 1234, kind: "pdf", sha256: HASH };
  assert.deepEqual(chatCardSchema.parse(card), card);
  for (const bad of [{ name: "a/b.pdf" }, { name: "a\\b.pdf" }, { name: "bad\u0000.pdf" }, { name: " padded.pdf" }, { name: "" }, { name: "x".repeat(256) }, { kind: "executable" }, { size: -1 },
    { size: 1.5 }, { size: 2 * 1024 ** 3 }, { sha256: "xyz" }, { sha256: HASH.toUpperCase() }, { direction: "sideways" }, { extra: true }])
    assert.equal(chatCardSchema.safeParse({ ...card, ...bad }).success, false, JSON.stringify(bad));
});

test("an agent cannot post an inbox file card; only the owner's own upload creates one", async () => {
  const { ChatDataError, appendAgentCard } = unwrap(await import("../lib/chat/data.ts"));
  const base = { type: "file", name: "x.txt", size: 1, kind: "text", sha256: HASH };
  for (const direction of ["inbox"]) {
    await assert.rejects(appendAgentCard(null, OWNER, AGENT, { card: { ...base, direction } }), (error) => error instanceof ChatDataError && error.code === "invalid_card");
  }
});

test("the browser helpers give early feedback and plain messages, and never echo server text", async () => {
  const { formatBytes, precheckFile, uploadErrorMessage } = unwrap(await import("../lib/chat/upload.ts"));
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(250 * 1024 * 1024), "250 MB");
  assert.equal(formatBytes(1024 ** 3), "1 GB");
  assert.equal(precheckFile({ name: "a.txt", size: 0 }, 100)?.code, "empty_file");
  assert.equal(precheckFile({ name: "a.txt", size: 101 }, 100)?.code, "file_too_large");
  assert.equal(precheckFile({ name: "a.txt", size: 100 }, 100), null);
  assert.equal(precheckFile({ name: "a.txt", size: 10 ** 12 }), null, "no limit known: the server decides");
  assert.equal(precheckFile({ name: "é".repeat(1500), size: 5 }, 100)?.code, "name_invalid");
  for (const name of ["a.pdf", "a.docx", "a.png", "a.mp3", "a.mp4", "a.md", "a.csv"]) assert.equal(precheckFile({ name, size: 5 }, 100), null, name);
  assert.equal(precheckFile({ name: "clip", type: "video/webm", size: 5 }, 100), null, "MIME type is enough");
  for (const name of ["a.exe", "a.zip", "a.sh", "noext"]) assert.equal(precheckFile({ name, size: 5 }, 100)?.code, "type_unsupported", name);
  assert.equal(precheckFile({ name: "a.exe", size: 101 }, 100)?.code, "file_too_large", "size warning wins");
  assert.match(uploadErrorMessage("file_too_large", 250 * 1024 * 1024), /250 MB limit/);
  assert.match(uploadErrorMessage("type_blocked"), /isn't accepted/);
  assert.equal(uploadErrorMessage("anything <b>else</b>"), "Couldn't upload this file. Try again.");
});

test("the outbox routes accept only the right methods and refuse anonymous requests with safe headers", async () => {
  const [refresh, download, open] = await Promise.all([
    import("../app/api/agents/[agentId]/outbox/refresh/route.ts"),
    import("../app/api/agents/[agentId]/files/[messageId]/route.ts"),
    import("../app/api/agents/[agentId]/files/open/route.ts"),
  ].map((promise) => promise.then(unwrap)));
  assert.equal(typeof refresh.POST, "function"); assert.equal(refresh.GET, undefined);
  assert.equal(typeof download.GET, "function"); assert.equal(download.POST, undefined);
  assert.equal(typeof open.POST, "function"); assert.equal(open.GET, undefined);
  const message = randomUUID();
  const calls = [
    [refresh.POST, new Request(`http://127.0.0.1:3000/api/agents/${AGENT}/outbox/refresh`, { method: "POST", headers: { Origin: "http://127.0.0.1:3000" } }), { agentId: AGENT }],
    [download.GET, new Request(`http://127.0.0.1:3000/api/agents/${AGENT}/files/${message}`), { agentId: AGENT, messageId: message }],
    [open.POST, new Request(`http://127.0.0.1:3000/api/agents/${AGENT}/files/open`, { method: "POST", headers: { Origin: "http://127.0.0.1:3000", "Content-Type": "application/json" }, body: JSON.stringify({ messageId: message }) }), { agentId: AGENT }],
  ];
  for (const [handler, request, params] of calls) {
    const response = await handler(request, { params: Promise.resolve(params) });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
});

test("outbox errors map to safe statuses and never echo internal text", async () => {
  const { outboxError } = unwrap(await import("../lib/chat/outbox-http.ts"));
  for (const [code, status] of [["file_not_found", 404], ["file_changed", 409], ["session_not_running", 409], ["takeover_active", 409], ["forbidden_target", 415], ["target_not_found", 404], ["agent_unavailable", 404], ["scan_failed", 503]]) {
    const response = outboxError(Object.assign(new Error(`private /workspace/homes/${AGENT}`), { code }));
    assert.equal(response.status, status, code);
    const body = await response.json();
    assert.match(body.error, /^[a-z_]+$/); assert.doesNotMatch(JSON.stringify(body), /workspace|private/);
  }
  const unknown = outboxError(new Error("CANARY detail"));
  assert.equal(unknown.status, 503); assert.doesNotMatch(await unknown.text(), /CANARY/);
});

test("the browser's and the desktop's lists of openable files are identical, and unsafe types are download-only", async () => {
  const { OPENABLE_EXTENSIONS, canOpenOnDesktop } = unwrap(await import("../lib/chat/file-types.ts"));
  const { OPENABLE } = await import("../docker/desktop/outbox-reader.mjs");
  assert.deepEqual(JSON.parse(JSON.stringify(OPENABLE_EXTENSIONS)), OPENABLE);
  assert.equal(canOpenOnDesktop("photo.PNG", "image"), true);
  assert.equal(canOpenOnDesktop("report.pdf", "pdf"), true);
  assert.equal(canOpenOnDesktop("notes.txt", "text"), true);
  for (const [name, kind] of [["page.html", "text"], ["image.svg", "image"], ["data.xml", "text"], ["pack.zip", "archive"], ["doc.docx", "document"], ["photo.png", "text"], ["noextension", "image"], [".png", "image"], ["x.png", "constructor"]])
    assert.equal(canOpenOnDesktop(name, kind), false, `${name} ${kind}`);
});

test("an agent cannot post an inbox card even when the card is otherwise valid, but may post an outbox card", async () => {
  const { appendAgentCard } = unwrap(await import("../lib/chat/data.ts"));
  const card = { type: "file", name: "x.txt", size: 1, kind: "text", sha256: HASH };
  await assert.rejects(appendAgentCard(null, OWNER, AGENT, { card: { ...card, direction: "inbox" } }), { code: "invalid_card" });
  await assert.rejects(appendAgentCard(null, OWNER, AGENT, { card: { ...card, direction: "outbox" } }), (error) => error.code !== "invalid_card", "an outbox card passes validation and only then needs the database");
});
