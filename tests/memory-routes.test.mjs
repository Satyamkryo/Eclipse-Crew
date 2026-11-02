import assert from "node:assert/strict";
import test from "node:test";

const AGENT = "11111111-1111-4111-8111-111111111111";
const ENTRY = "22222222-2222-4222-8222-222222222222";
const unwrap = (module) => module.default ?? module;
const request = (path, method = "GET") => new Request(`http://127.0.0.1:3000${path}`, { method });

test("memory routes expose only authenticated handlers", async () => {
  const [documents, entries, entry, soul, history] = await Promise.all([
    import("../app/api/memory/[agentId]/route.ts"),
    import("../app/api/memory/[agentId]/entries/route.ts"),
    import("../app/api/memory/entries/[entryId]/route.ts"),
    import("../app/api/memory/[agentId]/soul/route.ts"),
    import("../app/api/memory/[agentId]/history/route.ts"),
  ]);
  assert.equal(typeof unwrap(documents).GET, "function");
  assert.equal(unwrap(documents).POST, undefined);
  assert.equal(typeof unwrap(entries).POST, "function");
  assert.equal(typeof unwrap(entry).PATCH, "function");
  assert.equal(typeof unwrap(entry).DELETE, "function");
  assert.equal(typeof unwrap(soul).PUT, "function");
  assert.equal(typeof unwrap(history).GET, "function");
});

test("every memory route returns 401 without an owner session", async () => {
  const [documents, entries, entry, soul, history] = await Promise.all([
    import("../app/api/memory/[agentId]/route.ts"),
    import("../app/api/memory/[agentId]/entries/route.ts"),
    import("../app/api/memory/entries/[entryId]/route.ts"),
    import("../app/api/memory/[agentId]/soul/route.ts"),
    import("../app/api/memory/[agentId]/history/route.ts"),
  ]);
  const responses = await Promise.all([
    unwrap(documents).GET(request(`/api/memory/${AGENT}`), { params: Promise.resolve({ agentId: AGENT }) }),
    unwrap(entries).POST(request(`/api/memory/${AGENT}/entries`, "POST"), { params: Promise.resolve({ agentId: AGENT }) }),
    unwrap(entry).PATCH(request(`/api/memory/entries/${ENTRY}`, "PATCH"), { params: Promise.resolve({ entryId: ENTRY }) }),
    unwrap(soul).PUT(request(`/api/memory/${AGENT}/soul`, "PUT"), { params: Promise.resolve({ agentId: AGENT }) }),
    unwrap(history).GET(request(`/api/memory/${AGENT}/history?doc=user`), { params: Promise.resolve({ agentId: AGENT }) }),
  ]);
  for (const response of responses) {
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Unauthorized" });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});
