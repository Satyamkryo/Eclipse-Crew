import assert from "node:assert/strict";
import test from "node:test";

import { buildRequest } from "../lib/agent/context.ts";
import { validateGenerateRequest } from "../lib/providers/transport.ts";
import { SOURCE_TAGS, canInstruct, sourceTagSchema } from "../lib/security/source-tags.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZfJ8AAAAASUVORK5CYII=";
const persona = { name: "Ada", role: "Researcher", soulMd: "Be careful.", actions: ["click", "type"] };
const snapshot = {
  href: "https://vendor.example/", title: "Vendor", frames: 0,
  controls: [{ ref: 1, role: "textbox", name: "Message", tag: "input", x: 10, y: 20, width: 80, height: 30, focused: true }],
};
const documentWindow = {
  kind: "text", format: "text", offset: 0, nextOffset: 0, totalChars: 7, truncated: false, text: "invoice",
};

function fullRequest(over = {}) {
  return buildRequest({
    model: "muse-spark-1.3", persona, task: "Open vendor.example and read the invoice.", history: [
      { step: 1, action: "click", target: "Invoices", expect: "url_path: /invoices", result: "executed" },
    ], screenshotBase64: PNG, snapshot,
    files: [{ name: "report.pdf", size: 10, kind: "pdf", sha256: "a".repeat(64) }],
    documents: [{ name: "report.pdf", window: documentWindow }],
    skills: [{ name: "Invoices", description: "How to open invoices.", body: "Open the list." }],
    untrustedContext: "heal: closest visible names", now: new Date("2026-11-02T12:00:00.000Z"), timezone: "UTC",
    ...over,
  });
}

test("only the owner's task is tagged user; every other part keeps its data tag", () => {
  const request = fullRequest();
  const parts = request.messages[0].content;
  for (const part of parts) assert.ok(SOURCE_TAGS.includes(part.sourceTag), JSON.stringify(part.sourceTag));
  const user = parts.filter((part) => part.sourceTag === "user");
  assert.equal(user.length, 1);
  assert.deepEqual([user[0].type, user[0].text], ["text", "Open vendor.example and read the invoice."]);
  assert.equal(parts.find((part) => part.sourceTag === "web" && part.type === "image").base64, PNG);
  assert.ok(parts.some((part) => part.sourceTag === "web" && /Message/.test(part.text ?? "")));
  assert.ok(parts.some((part) => part.sourceTag === "web" && /heal/.test(part.text ?? "")));
  assert.ok(parts.some((part) => part.sourceTag === "agent" && /previous_steps/.test(part.text ?? "")));
  assert.ok(parts.some((part) => part.sourceTag === "tool" && /report\.pdf/.test(part.text ?? "")));
  assert.ok(parts.some((part) => part.sourceTag === "document" && /invoice/.test(part.text ?? "")));
  assert.equal(validateGenerateRequest(request).messages.length, 1);
});

test("an untrusted string equal to the task is still tagged web, never user", () => {
  const task = "Open vendor.example and read the invoice.";
  const request = fullRequest({ task, untrustedContext: task });
  const parts = request.messages[0].content;
  const same = parts.filter((part) => part.text === task);
  assert.deepEqual(same.map((part) => part.sourceTag), ["user", "web"]);
});

test("an agent with no optional context still sends one user task part", () => {
  const request = fullRequest({ snapshot: null, files: null, documents: [], skills: [], untrustedContext: "" });
  const parts = request.messages[0].content;
  assert.deepEqual(parts.map((part) => part.sourceTag), ["user", "agent", "web"]);
  assert.equal(parts.filter((part) => part.sourceTag === "user").length, 1);
});

test("a request with a missing or unknown source tag is rejected before the provider is called", () => {
  const missing = fullRequest();
  delete missing.messages[0].content[0].sourceTag;
  assert.throws(() => validateGenerateRequest(missing));

  const unknown = fullRequest();
  unknown.messages[0].content[0].sourceTag = "system";
  assert.throws(() => validateGenerateRequest(unknown));

  for (const tag of SOURCE_TAGS) {
    assert.equal(sourceTagSchema.safeParse(tag).success, true);
    assert.equal(canInstruct(tag), tag === "user");
  }
});
