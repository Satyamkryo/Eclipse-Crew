import assert from "node:assert/strict";
import test from "node:test";

import { createComposioClient, safeRedirectUrl } from "../lib/composio/client.ts";
import { classifyComposioTool, composioToolsHash, isDestructiveComposioTool, livePinFromTools } from "../lib/composio/risk.ts";
import { buildComposioSession, formatComposioResult } from "../lib/composio/session.ts";

const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json", ...headers },
});
const pinned = [{ slug: "GMAIL_FETCH_EMAILS", name: "Fetch", description: "", tags: ["readOnlyHint"], version: "1", hash: "a".repeat(64) }];

test("a session body is built only from stored state and never enables charges or sandboxes", () => {
  const body = buildComposioSession({
    agentId: "11111111-1111-4111-8111-111111111111",
    accounts: [{ toolkit: "gmail", connectedAccountId: "ca_1" }],
    pinned,
    injectionCheck: false,
  });
  assert.equal(body.instant, false);
  assert.deepEqual(body.workbench, { enable: false });
  assert.deepEqual(body.manage_connections, { enable: false });
  assert.deepEqual(body.search, { enable: false });
  assert.deepEqual(body.execute, { enable_multi_execute: false });
  assert.deepEqual(body.tags, { disable: ["destructiveHint"] });
  assert.deepEqual(body.tools, { gmail: { enable: ["GMAIL_FETCH_EMAILS"] } });
  assert.deepEqual(body.connected_accounts, { gmail: ["ca_1"] });
  assert.equal("hooks" in body, false);
  const withHook = buildComposioSession({ agentId: body.user_id, accounts: [], pinned: [], injectionCheck: true });
  assert.deepEqual(withHook.hooks, [{
    id: "eclipse_injection_check", name: "Prompt injection", type: "after_execute", applies_to: "all",
    handler: { type: "prompt_injection_check", action: "block" },
  }]);
  const subset = buildComposioSession({
    agentId: body.user_id, accounts: [{ toolkit: "gmail", connectedAccountId: "ca_1" }], pinned: [...pinned, { ...pinned[0], slug: "GMAIL_SEND_EMAIL" }],
    injectionCheck: false, allowedSlugs: ["GMAIL_FETCH_EMAILS"],
  });
  assert.deepEqual(subset.tools.gmail.enable, ["GMAIL_FETCH_EMAILS"]);
});

test("Composio risk combines tags and slug verbs, with the stricter winning", () => {
  assert.equal(classifyComposioTool("GMAIL_FETCH_EMAILS", ["readOnlyHint"]), "none");
  assert.equal(classifyComposioTool("SLACK_LIST_CHANNELS"), "none");
  assert.equal(classifyComposioTool("GMAIL_SEND_EMAIL", ["createHint"]), "send");
  assert.equal(classifyComposioTool("SLACK_CREATE_CHANNEL"), "post");
  assert.equal(classifyComposioTool("STRIPE_PURCHASE_ITEM"), "purchase");
  assert.equal(classifyComposioTool("NOTION_DELETE_PAGE"), "delete");
  assert.equal(classifyComposioTool("GMAIL_DELETE_MESSAGE", ["readOnlyHint"]), "delete");
  assert.equal(classifyComposioTool("WEIRD_TOOL"), "post");
  assert.equal(isDestructiveComposioTool({ slug: "NOTION_ARCHIVE_PAGE" }), true);
  assert.equal(isDestructiveComposioTool({ slug: "GMAIL_FETCH_EMAILS", tags: ["readOnlyHint"] }), false);
});

test("the pin hash covers the slug, schema, tags and version and excludes destructive tools", () => {
  const live = [
    { slug: "GMAIL_FETCH_EMAILS", name: "Fetch", input_parameters: { type: "object" }, tags: ["readOnlyHint"], version: "1" },
    { slug: "GMAIL_DELETE_MESSAGE", name: "Delete", tags: ["destructiveHint"], version: "1" },
    { slug: "GMAIL_SEND_EMAIL", name: "Send", input_parameters: { type: "object" }, version: "1" },
  ];
  const { pinned: pinnedTools, hash } = livePinFromTools(live);
  assert.deepEqual(pinnedTools.map((tool) => tool.slug), ["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"]);
  assert.equal(composioToolsHash(pinnedTools), hash);
  const changed = livePinFromTools([{ ...live[0], version: "2" }, live[1], live[2]]);
  assert.notEqual(changed.hash, hash);
});

test("the REST client pages tools, keeps no long reply and maps answers to fixed codes", async () => {
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url, ...init });
    if (url.endsWith("/tool_router/session")) return json({ session_id: "s1" });
    if (url.includes("/tools?")) {
      const page = url.includes("cursor=c2") ? { items: [{ slug: "GMAIL_GET_PROFILE" }], next_cursor: null } : { items: [{ slug: "GMAIL_FETCH_EMAILS" }], next_cursor: "c2" };
      return json(page);
    }
    if (url.includes("/toolkits?")) return json({ items: [{ slug: "gmail", connected_account: { id: "ca_1", status: "ACTIVE" } }] });
    if (url.endsWith("/link")) return json({ connected_account_id: "ca_1", redirect_url: "https://platform.composio.dev/link/1" });
    if (url.endsWith("/execute")) return json({ result_type: "completed", data: { ok: true }, error: null });
    if (url.includes("/connected_accounts/")) return json({ success: true });
    throw new Error("unexpected " + url);
  };
  const client = createComposioClient({ transport });
  const session = await client.createSession({ user_id: "a" });
  assert.equal(session, "s1");
  const tools = await client.listTools("s1");
  assert.deepEqual(tools.map((tool) => tool.slug), ["GMAIL_FETCH_EMAILS", "GMAIL_GET_PROFILE"]);
  assert.equal((await client.toolkitStatus("s1", ["gmail"]))[0].status, "ACTIVE");
  assert.equal((await client.createLink("s1", "gmail")).redirectUrl, "https://platform.composio.dev/link/1");
  assert.equal((await client.execute("s1", "GMAIL_FETCH_EMAILS", {})).resultType, "completed");
  assert.equal(await client.deleteAccount("ca_1"), true);
  assert.equal(calls.some((call) => call.headers["x-api-key"]), false, "the proxy injects the key, not the app");

  const coded = (status) => createComposioClient({ transport: async () => new Response("{}", { status }) });
  await assert.rejects(() => coded(401).createSession({}), (error) => error.code === "key_rejected");
  await assert.rejects(() => coded(404).createSession({}), (error) => error.code === "composio_not_found");
  await assert.rejects(() => coded(429).createSession({}), (error) => error.code === "composio_rate_limited");
  await assert.rejects(() => coded(501).createSession({}), (error) => error.status === 501);
  await assert.rejects(() => coded(500).createSession({}), (error) => error.code === "composio_unreachable");
  const unexpected = createComposioClient({ transport: async () => json({ nope: true }) });
  await assert.rejects(() => unexpected.createSession({}), (error) => error.code === "composio_unexpected_reply");
});

test("only composio.dev https links are accepted, and results are bounded", () => {
  assert.equal(safeRedirectUrl("https://platform.composio.dev/link/1"), "https://platform.composio.dev/link/1");
  for (const bad of ["http://platform.composio.dev/x", "https://evil.test/x", "https://composio.dev.evil.test/x", "https://user:pw@composio.dev/x", "not a url"]) {
    assert.equal(safeRedirectUrl(bad), null, bad);
  }
  assert.equal(formatComposioResult({ a: 1 }), "{\"a\":1}");
  assert.equal(formatComposioResult("x".repeat(20_000)).length, 16_000);
});
