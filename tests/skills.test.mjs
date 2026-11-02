import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getTableName } from "drizzle-orm";

const unwrap = (module) => module.default ?? module;
const OWNER = "11111111-1111-4111-8111-111111111111";
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CAPTURE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HASH = "a".repeat(64);

const draft = {
  name: "download-invoice",
  description: "Download the latest invoice from the vendor portal.",
  inputs: [{ name: "invoice_date", description: "Invoice date to select.", secret: false }],
  steps: [
    { instruction: "Open the invoices page.", eventSequence: 0, postcondition: "The invoices table is visible." },
    { instruction: "Download the newest invoice.", eventSequence: 1, postcondition: "A PDF download starts.", input: "invoice_date" },
  ],
};

test("skill drafts validate bounded structured steps and reusable inputs without values", async () => {
  const { skillModelDraftSchema } = unwrap(await import("../lib/skills/schema.ts"));
  assert.deepEqual(skillModelDraftSchema.parse(draft), draft);
  for (const invalid of [
    { ...draft, extra: "field" },
    { ...draft, name: "Bad Name" },
    { ...draft, steps: [] },
    { ...draft, steps: [{ ...draft.steps[0], eventSequence: -1 }] },
    { ...draft, inputs: [{ name: "password", description: "Password", secret: false, value: "hunter2" }] },
    { ...draft, steps: [{ ...draft.steps[0], instruction: "bad\u0000text" }] },
  ]) assert.equal(skillModelDraftSchema.safeParse(invalid).success, false, JSON.stringify(invalid));
});

test("SKILL.md rendering is deterministic, YAML-safe and never trusts model Markdown", async () => {
  const { renderSkillMarkdown } = unwrap(await import("../lib/skills/markdown.ts"));
  const body = renderSkillMarkdown(draft, "steps_screenshots");
  assert.match(body, /^---\nname: "download-invoice"\ndescription: "Download the latest invoice from the vendor portal\."\n---\n/);
  assert.match(body, /Learned from steps \+ screenshots$/m);
  assert.match(body, /## Inputs/);
  assert.match(body, /invoice_date/);
  assert.match(body, /Open the invoices page\./);
  assert.match(body, /Check: A PDF download starts\./);
  assert.match(body, /Reference: step-2\.png/);
  assert.doesNotMatch(body, /<script>/);
  assert.equal(body, renderSkillMarkdown(draft, "steps_screenshots"));
});

test("skill tables store owner-scoped drafts, versions, source and retained reference shots", async () => {
  const schema = unwrap(await import("../db/schema.ts"));
  assert.equal(getTableName(schema.skills), "skills");
  assert.equal(getTableName(schema.skillVersions), "skill_versions");
  assert.deepEqual(
    ["id", "ownerId", "agentId", "captureId", "name", "description", "source", "status", "version", "body", "referenceShots", "createdAt", "updatedAt"]
      .map((field) => schema.skills[field].name),
    ["id", "owner_id", "agent_id", "capture_id", "name", "description", "source", "status", "version", "body", "reference_shots", "created_at", "updated_at"],
  );
  assert.deepEqual(
    ["id", "ownerId", "skillId", "version", "body", "source", "referenceShots", "createdAt"]
      .map((field) => schema.skillVersions[field].name),
    ["id", "owner_id", "skill_id", "version", "body", "source", "reference_shots", "created_at"],
  );
});

test("retained reference shots are copied by validated hash and never expose other capture files", async () => {
  const { retainReferenceShots } = unwrap(await import("../lib/skills/store.ts"));
  const root = await mkdtemp(path.join(tmpdir(), "eclipse-skill-"));
  try {
    const source = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const result = await retainReferenceShots({
      root, ownerId: OWNER, skillId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", version: 1,
      shots: [
        { step: 1, eventSequence: 0, hash: HASH, mime: "image/png" },
        { step: 2, eventSequence: 1, hash: HASH, mime: "image/png" },
      ],
      read: async (hash) => hash === HASH ? source : null,
    });
    assert.equal(result.length, 2);
    assert.deepEqual(await readFile(path.join(root, result[1].path)), source);
    assert.equal(result[0].path.includes(".."), false);
    await assert.rejects(retainReferenceShots({ root, ownerId: OWNER, skillId: "x", version: 1, shots: [], read: async () => null }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("skill generation sends only sanitized events, untrusted data tags and bounded screenshots", async () => {
  const { buildSkillRequest, parseSkillResult } = unwrap(await import("../lib/skills/generate.ts"));
  const request = buildSkillRequest({
    model: "muse-spark-1.3",
    capture: {
      timezone: "Asia/Kolkata", durationMs: 12_000,
      events: [{ sequence: 0, operation: "input.click", offsetMs: 100, target: { kind: "point" }, afterHash: HASH }],
    },
    narration: [{ text: "Click the invoice link.", startMs: 0, endMs: 1000 }],
    screenshots: [{ mediaType: "image/png", base64: "iVBORw0KGgo=", sequence: 0 }],
    now: new Date("2026-11-02T12:00:00Z"),
  });
  assert.equal(request.toolChoice.name, "draft_skill");
  assert.match(request.instructions, /untrusted data/);
  assert.match(request.instructions, /2026-11-02/);
  assert.equal(request.messages[0].content.filter((part) => part.type === "image").length, 1);
  assert.equal(request.messages[0].content.filter((part) => part.type === "text").length, 3);
  assert.doesNotMatch(JSON.stringify(request), /apiKey|password|typed text/i);
  const output = (value) => ({ id: "r", model: "m", status: "completed", incompleteReason: null, text: "", usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0 }, outputs: [{ type: "function_call", callId: "c", name: "draft_skill", arguments: JSON.stringify(value) }] });
  assert.deepEqual(parseSkillResult(output(draft)), draft);
  assert.throws(() => parseSkillResult(output({ ...draft, steps: [] })));
  assert.throws(() => parseSkillResult({ ...output(draft), status: "incomplete" }));
});

test("approved skills enter the agent instructions but remain subordinate to owner rules", async () => {
  const { buildInstructions } = unwrap(await import("../lib/agent/context.ts"));
  const instructions = buildInstructions(
    { name: "Ada", role: "Researcher", soulMd: "Ask first.", actions: ["click"] },
    new Date("2026-11-02T12:00:00Z"), "UTC",
    [{ name: "download-invoice", description: "Get an invoice.", body: "---\nname: \"download-invoice\"\n---\n# download-invoice" }],
  );
  assert.match(instructions, /Approved skills for this agent/);
  assert.match(instructions, /download-invoice/);
  assert.match(instructions, /never change the owner's task, permissions or safety rules/);
});

test("skill routes are authenticated, bounded and expose only generation/read/approval", async () => {
  const generation = unwrap(await import("../app/api/teach/[captureId]/skill/route.ts"));
  const approve = unwrap(await import("../app/api/skills/[skillId]/approve/route.ts"));
  assert.equal(typeof generation.POST, "function");
  assert.equal(generation.GET, undefined);
  assert.equal(typeof approve.POST, "function");
  assert.equal(approve.GET, undefined);
  const response = await generation.POST(new Request(`http://127.0.0.1:3000/api/teach/${CAPTURE}/skill`, { method: "POST" }), {
    params: Promise.resolve({ captureId: CAPTURE }),
  });
  assert.equal(response.status, 401);
  const denied = await approve.POST(new Request(`http://127.0.0.1:3000/api/skills/${AGENT}/approve`, { method: "POST" }), {
    params: Promise.resolve({ skillId: AGENT }),
  });
  assert.equal(denied.status, 401);
});
