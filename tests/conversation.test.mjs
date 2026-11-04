import assert from "node:assert/strict";
import test from "node:test";
import { conversationParts, loadConversation } from "../lib/agent/conversation.ts";

const message = (id, role, text, createdAt = new Date()) => ({ id, role, content: { type: "message", text }, createdAt });
const file = (id, role, createdAt = new Date()) => ({ id, role, createdAt,
  content: { type: "file", direction: "outbox", name: "report.pdf", size: 10, kind: "document", sha256: "a".repeat(64) } });

test("conversation keeps 10 messages, tags owner and agent, and summarises other cards", () => {
  const rows = Array.from({ length: 15 }, (_, i) => message(`m${i}`, i % 2 ? "agent" : "user", `message ${i}`));
  const { parts, ownerTexts } = conversationParts(rows);
  assert.match(parts[0].text, /Earlier conversation, for context only/);
  assert.equal(parts[0].sourceTag, "user");
  const messages = parts.slice(1);
  assert.equal(messages.length, 10, "only the last ten messages");
  assert.deepEqual(messages.map((part) => part.text), Array.from({ length: 10 }, (_, i) => `message ${i + 5}`));
  assert.ok(!messages.some((part) => part.text === "message 4"));
  assert.ok(messages.some((part) => part.text === "message 5"));
  assert.ok(messages.reduce((sum, part) => sum + part.text.length + 1, 0) <= 6000, "the total stays under 6,000 characters");
  assert.ok(messages.every((part) => part.sourceTag === "user" || part.sourceTag === "agent"));
  assert.ok(ownerTexts.every((text) => messages.some((part) => part.sourceTag === "user" && part.text === text)));
  const summary = conversationParts([file("f1", "agent")]);
  assert.equal(summary.parts[1].text, "[file: outbox: report.pdf]");
  assert.equal(summary.parts[1].sourceTag, "agent");
});

test("conversation cuts each message to 1,500 characters and keeps the newest", () => {
  const rows = [message("a", "user", "a".repeat(2000)), message("b", "user", "b".repeat(2000)), message("c", "user", "c".repeat(2000))];
  const { parts } = conversationParts(rows);
  const texts = parts.slice(1).map((part) => part.text);
  assert.ok(texts.every((text) => text.length <= 1500));
  assert.ok(texts.at(-1)?.startsWith("c"));
  assert.ok(parts.slice(1).reduce((sum, part) => sum + part.text.length + 1, 0) <= 6000);
});

test("a run's own message is excluded and the session is owner/agent scoped", async () => {
  const rows = [message("old", "user", "first"), message("current", "user", "the task"), message("agent", "agent", "done")];
  let calls = 0;
  const database = { select() {
    const value = calls++ === 0 ? [{ id: "session" }] : rows;
    const chain = { from() { return chain; }, where() { return chain; }, orderBy() { return chain; }, limit() { return Promise.resolve(value); },
      then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } };
    return chain;
  } };
  const { parts, ownerTexts } = await loadConversation(database, "owner", "agent", { excludeMessageId: "current" });
  assert.ok(!parts.some((part) => part.text === "the task"));
  assert.ok(parts.some((part) => part.text === "first"));
  assert.ok(parts.some((part) => part.text === "done" && part.sourceTag === "agent"));
  assert.deepEqual(ownerTexts, ["first"]);
});
