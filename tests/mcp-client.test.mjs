import assert from "node:assert/strict";
import test from "node:test";

import { createMcpClient } from "../lib/mcp/client.ts";
import { diffTools, toolsHash } from "../lib/mcp/pin.ts";

const URL = "https://api.githubcopilot.com/mcp/";
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json", ...headers },
});

function scripted(handler) {
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url, ...init, headers: { ...init.headers } });
    return handler(calls.length, JSON.parse(init.body));
  };
  return { transport, calls };
}

const initializeReply = (id) => ({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "Fake", version: "1.2" } } });

test("the client initializes once, keeps the session id and answers JSON and SSE replies", async () => {
  const { transport, calls } = scripted((index, body) => {
    if (body.method === "initialize") return json(initializeReply(body.id), 200, { "mcp-session-id": "s1" });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") return json({ jsonrpc: "2.0", id: body.id, result: { tools: [
      { name: "get_me", description: "Me", annotations: { title: "x".repeat(240), readOnlyHint: true, extraHint: true } },
      { name: "merge_pull_request", inputSchema: { type: "object" }, annotations: { destructiveHint: true } },
    ] } });
    if (body.method === "tools/call") {
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [
        { type: "text", text: "hello" }, { type: "image", data: "x" }, { type: "text", text: "world" },
      ], isError: false } })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    throw new Error("unexpected " + index);
  });
  const client = createMcpClient({ transport, url: URL });
  const info = await client.initialize();
  assert.deepEqual(info, { serverName: "Fake", serverVersion: "1.2", protocolVersion: "2025-06-18" });
  assert.equal(calls[1].headers["mcp-session-id"], "s1");
  const tools = await client.listTools();
  assert.equal(calls[2].headers["mcp-protocol-version"], "2025-06-18");
  assert.deepEqual(tools.map((tool) => tool.name), ["get_me", "merge_pull_request"]);
  assert.deepEqual(tools[0].annotations, { title: "x".repeat(200), readOnlyHint: true });
  const result = await client.callTool("get_me", { x: 1 });
  assert.equal(result.isError, false);
  assert.equal(result.text, "hello\n[image omitted]\nworld");
  assert.equal(calls.at(-1).body.includes("\"arguments\":{\"x\":1}"), true);
});

test("the client maps server answers to fixed codes", async () => {
  const errorClient = (status, body = {}) => createMcpClient({
    transport: async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
    url: URL,
  });
  await assert.rejects(() => errorClient(401).initialize(), (error) => error.code === "token_rejected");
  await assert.rejects(() => errorClient(404).initialize(), (error) => error.code === "not_an_mcp_server");
  await assert.rejects(() => errorClient(500).initialize(), (error) => error.code === "server_unreachable");
  await assert.rejects(() => errorClient(200, "not json").initialize(), (error) => error.code === "mcp_protocol_error");
  await assert.rejects(() => errorClient(200, { jsonrpc: "2.0", id: 1, error: { code: -1, message: "no" } }).initialize(),
    (error) => error.code === "mcp_protocol_error");
  const huge = createMcpClient({
    transport: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "x", serverInfo: {}, blob: "x".repeat(4000) } }),
      { status: 200, headers: { "content-type": "application/json" } }),
    url: URL, maxReplyBytes: 1000,
  });
  await assert.rejects(() => huge.initialize(), (error) => error.code === "mcp_reply_too_large");
});

test("the tool hash is stable, order-independent and changes on any tool, schema or annotation change", () => {
  const tools = [
    { name: "get_me", annotations: { readOnlyHint: true } },
    { name: "create_issue", inputSchema: { type: "object", properties: { title: { type: "string", metadata: { second: 2, first: 1 } } }, required: ["title"] } },
  ];
  const hash = toolsHash(tools);
  assert.equal(toolsHash([...tools].reverse()), hash);
  assert.equal(toolsHash([{ ...tools[1], inputSchema: { required: ["title"], properties: { title: { metadata: { first: 1, second: 2 }, type: "string" } }, type: "object" } }, tools[0]]), hash);
  assert.notEqual(toolsHash([{ ...tools[0], description: "changed" }, tools[1]]), hash);
  assert.notEqual(toolsHash([{ ...tools[0], annotations: { readOnlyHint: false } }, tools[1]]), hash);
  assert.notEqual(toolsHash([{ ...tools[1], inputSchema: { type: "object" } }, tools[0]]), hash);
  assert.deepEqual(diffTools(tools, [tools[0], { ...tools[1], description: "new" }, { name: "delete_repo" }]),
    { added: ["delete_repo"], removed: [], changed: ["create_issue"] });
});
