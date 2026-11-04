import assert from "node:assert/strict";
import test from "node:test";

const AGENT = "11111111-1111-4111-8111-111111111111";
const CONNECTION = "22222222-2222-4222-8222-222222222222";
const unwrap = (module) => module.default ?? module;
const request = (path, method = "GET") => new Request(`http://127.0.0.1:3000${path}`, { method });

test("connection routes expose only authenticated handlers", async () => {
  const [collection, item, testRoute, device, flow] = await Promise.all([
    import("../app/api/connections/route.ts"),
    import("../app/api/connections/[connectionId]/route.ts"),
    import("../app/api/connections/[connectionId]/test/route.ts"),
    import("../app/api/connections/github/device/route.ts"),
    import("../app/api/connections/github/device/[flowId]/route.ts"),
  ]);
  assert.equal(typeof unwrap(collection).GET, "function");
  assert.equal(typeof unwrap(collection).POST, "function");
  assert.equal(typeof unwrap(item).PUT, "function");
  assert.equal(typeof unwrap(item).DELETE, "function");
  assert.equal(typeof unwrap(testRoute).POST, "function");
  assert.equal(typeof unwrap(device).POST, "function");
  assert.equal(typeof unwrap(flow).GET, "function");
});

test("every connection route returns 401 without an owner session", async () => {
  const [collection, item, testRoute, device, flow] = await Promise.all([
    import("../app/api/connections/route.ts"),
    import("../app/api/connections/[connectionId]/route.ts"),
    import("../app/api/connections/[connectionId]/test/route.ts"),
    import("../app/api/connections/github/device/route.ts"),
    import("../app/api/connections/github/device/[flowId]/route.ts"),
  ]);
  const responses = await Promise.all([
    unwrap(collection).GET(request(`/api/connections?agentId=${AGENT}`)),
    unwrap(collection).POST(request("/api/connections", "POST")),
    unwrap(item).PUT(request(`/api/connections/${CONNECTION}`, "PUT"), { params: Promise.resolve({ connectionId: CONNECTION }) }),
    unwrap(item).DELETE(request(`/api/connections/${CONNECTION}`, "DELETE"), { params: Promise.resolve({ connectionId: CONNECTION }) }),
    unwrap(testRoute).POST(request(`/api/connections/${CONNECTION}/test`, "POST"), { params: Promise.resolve({ connectionId: CONNECTION }) }),
    unwrap(device).POST(request("/api/connections/github/device", "POST")),
    unwrap(flow).GET(request(`/api/connections/github/device/${CONNECTION}`), { params: Promise.resolve({ flowId: CONNECTION }) }),
  ]);
  for (const response of responses) {
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Unauthorized" });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});
