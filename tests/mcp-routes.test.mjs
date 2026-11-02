import assert from "node:assert/strict";
import test from "node:test";

const AGENT = "11111111-1111-4111-8111-111111111111";
const SERVER = "22222222-2222-4222-8222-222222222222";
const unwrap = (module) => module.default ?? module;
const request = (path, method = "GET") => new Request(`http://127.0.0.1:3000${path}`, { method });

test("MCP routes expose only authenticated handlers", async () => {
  const [collection, item] = await Promise.all([
    import("../app/api/mcp-servers/route.ts"),
    import("../app/api/mcp-servers/[serverId]/route.ts"),
  ]);
  assert.equal(typeof unwrap(collection).GET, "function");
  assert.equal(typeof unwrap(collection).POST, "function");
  assert.equal(typeof unwrap(item).PATCH, "function");
  assert.equal(typeof unwrap(item).DELETE, "function");
});

test("every MCP route returns 401 without an owner session", async () => {
  const [collection, item] = await Promise.all([
    import("../app/api/mcp-servers/route.ts"),
    import("../app/api/mcp-servers/[serverId]/route.ts"),
  ]);
  const responses = await Promise.all([
    unwrap(collection).GET(request(`/api/mcp-servers?agentId=${AGENT}`)),
    unwrap(collection).POST(request("/api/mcp-servers", "POST")),
    unwrap(item).PATCH(request(`/api/mcp-servers/${SERVER}`, "PATCH"), { params: Promise.resolve({ serverId: SERVER }) }),
    unwrap(item).DELETE(request(`/api/mcp-servers/${SERVER}`, "DELETE"), { params: Promise.resolve({ serverId: SERVER }) }),
  ]);
  for (const response of responses) {
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Unauthorized" });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});
