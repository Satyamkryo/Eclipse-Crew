import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("hex");

const SECRET = "ab".repeat(32);
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONNECTION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const { connectionCreateSchema, connectionUpdateSchema, connectionBindingsSchema } = await import("../lib/connections/schema.ts");
const { CONNECTION_PRESETS, presetBindings } = await import("../lib/connections/presets.ts");
const { createToolTransport, ToolTransportError } = await import("../lib/connections/transport.ts");
const { testConnection } = await import("../lib/connections/service.ts");
const { encryptSecret } = await import("../lib/security/encryption.ts");

const TOKEN = "github_pat_11AAABBBCCCDDDEEEFFF123456789";

test("presets expand to exact host bindings", () => {
  const github = presetBindings("github", undefined);
  assert.equal(github.length, 3);
  assert.deepEqual(github.map((binding) => binding.host), ["api.githubcopilot.com", "api.github.com", "github.com"]);
  assert.deepEqual(github.at(-1), { host: "github.com", scheme: "basic", username: "x-access-token" });
  assert.deepEqual(presetBindings("custom", "api.example.com"), [{ host: "api.example.com", scheme: "bearer" }]);
  assert.deepEqual(presetBindings("custom", "api.example.com", "header"), [{ host: "api.example.com", scheme: "header", header: "x-api-key" }]);
  assert.equal(CONNECTION_PRESETS.github.test, true);
  assert.equal(CONNECTION_PRESETS.custom.test, false);
});

test("create input is strict about hosts, tokens and extra fields", () => {
  const valid = { agentId: AGENT, preset: "github", label: "Work", token: TOKEN };
  assert.equal(connectionCreateSchema.safeParse(valid).success, true);
  for (const bad of [
    { ...valid, extra: 1 },
    { ...valid, token: ` ${TOKEN}` },
    { ...valid, token: "short" },
    { ...valid, token: `${TOKEN}\n` },
    { ...valid, label: "  " },
    { ...valid, host: "api.github.com" },
    { agentId: AGENT, preset: "custom", label: "X", token: TOKEN },
    { agentId: AGENT, preset: "custom", label: "X", token: TOKEN, host: "127.0.0.1" },
    { agentId: AGENT, preset: "custom", label: "X", token: TOKEN, host: "*.example.com" },
  ]) {
    assert.equal(connectionCreateSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
  assert.equal(connectionCreateSchema.safeParse({ ...valid, token: TOKEN, scheme: "header" }).success, false);
  assert.equal(connectionUpdateSchema.safeParse({}).success, false);
  assert.equal(connectionUpdateSchema.safeParse({ token: "" }).success, true);
  assert.equal(connectionBindingsSchema.safeParse([{ host: "api.github.com", scheme: "basic" }]).success, false);
});

test("the tool transport never carries a credential and only forwards allowed headers", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return new Response("{}", { status: 200, headers: { "x-eclipse-proxy": "ok" } });
  };
  const transport = createToolTransport({ agentId: AGENT, secret: SECRET, baseUrl: "http://proxy.test", fetchImpl });
  await transport("https://api.github.com/user", {
    method: "GET",
    headers: { Accept: "application/json", Authorization: "Bearer attacker", Cookie: "a=b", "MCP-Session-Id": "s1" },
  });
  assert.equal(captured.url, "http://proxy.test/v1/tool-forward");
  assert.equal(captured.init.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(captured.init.headers["X-Eclipse-Agent"], AGENT);
  assert.equal(captured.init.headers.accept, "application/json");
  assert.equal(captured.init.headers["mcp-session-id"], "s1");
  assert.equal(captured.init.headers.cookie, undefined);
  assert.equal(captured.init.headers.authorization, undefined);
  await assert.rejects(() => transport("http://api.github.com/user", { method: "GET" }), /forbidden_target/);
  await assert.rejects(() => transport("https://user:pw@api.github.com/user", { method: "GET" }), /forbidden_target/);
});

test("a proxy rejection becomes a fixed error code without a body echo", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: "agent_unavailable" }), {
    status: 403, headers: { "x-eclipse-proxy": "error" },
  });
  const transport = createToolTransport({ agentId: AGENT, secret: SECRET, baseUrl: "http://proxy.test", fetchImpl });
  await assert.rejects(() => transport("https://api.github.com/user", { method: "GET" }),
    (error) => error instanceof ToolTransportError && error.code === "agent_unavailable");
});

function fakeDatabase(row) {
  return { select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }) };
}

const stored = {
  id: CONNECTION,
  ownerId: "00000000-0000-0000-0000-000000000001",
  agentId: AGENT,
  preset: "github",
  label: "Work",
  bindings: CONNECTION_PRESETS.github.bindings,
  encryptedToken: encryptSecret(TOKEN),
  tokenHint: "••••6789",
  createdAt: new Date(),
  updatedAt: new Date(),
};

test("a connection test reports accepted, rejected and unreachable without echoing the upstream", async () => {
  const ownerId = stored.ownerId;
  const accepted = await testConnection(fakeDatabase(stored), ownerId, CONNECTION,
    () => async () => new Response("", { status: 200, headers: { "x-eclipse-proxy": "ok" } }));
  assert.equal(accepted.status, "accepted");
  const rejected = await testConnection(fakeDatabase(stored), ownerId, CONNECTION,
    () => async () => new Response("", { status: 401, headers: { "x-eclipse-proxy": "ok" } }));
  assert.equal(rejected.status, "rejected");
  const unreachable = await testConnection(fakeDatabase(stored), ownerId, CONNECTION,
    () => async () => { throw new ToolTransportError("upstream_error", 502); });
  assert.equal(unreachable.status, "unreachable");
  await assert.rejects(() => testConnection(fakeDatabase({ ...stored, preset: "custom" }), ownerId, CONNECTION),
    (error) => error.code === "test_unsupported");
  await assert.rejects(() => testConnection({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) },
    ownerId, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
    (error) => error.code === "not_found");
});
