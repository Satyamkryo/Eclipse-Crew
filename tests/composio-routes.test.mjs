import assert from "node:assert/strict";
import test from "node:test";

const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const unwrap = (module) => module.default ?? module;
const request = (path, method = "GET") => new Request(`http://127.0.0.1:3000${path}`, { method });

test("Composio routes expose only authenticated handlers", async () => {
  const [key, accounts, account, refresh] = await Promise.all([
    import("../app/api/composio/key/route.ts"),
    import("../app/api/composio/accounts/route.ts"),
    import("../app/api/composio/accounts/[accountId]/route.ts"),
    import("../app/api/composio/accounts/[accountId]/refresh/route.ts"),
  ]);
  assert.equal(typeof unwrap(key).GET, "function");
  assert.equal(typeof unwrap(key).PUT, "function");
  assert.equal(typeof unwrap(key).DELETE, "function");
  assert.equal(typeof unwrap(accounts).GET, "function");
  assert.equal(typeof unwrap(accounts).POST, "function");
  assert.equal(typeof unwrap(account).GET, "function");
  assert.equal(typeof unwrap(account).PATCH, "function");
  assert.equal(typeof unwrap(account).DELETE, "function");
  assert.equal(typeof unwrap(refresh).POST, "function");
});

test("every Composio route returns 401 without an owner session", async () => {
  const [key, accounts, account, refresh] = await Promise.all([
    import("../app/api/composio/key/route.ts"),
    import("../app/api/composio/accounts/route.ts"),
    import("../app/api/composio/accounts/[accountId]/route.ts"),
    import("../app/api/composio/accounts/[accountId]/refresh/route.ts"),
  ]);
  const responses = await Promise.all([
    unwrap(key).GET(request("/api/composio/key")),
    unwrap(key).PUT(request("/api/composio/key", "PUT")),
    unwrap(key).DELETE(request("/api/composio/key", "DELETE")),
    unwrap(accounts).GET(request("/api/composio/accounts")),
    unwrap(accounts).POST(request("/api/composio/accounts", "POST")),
    unwrap(account).GET(request(`/api/composio/accounts/${ACCOUNT}`), { params: Promise.resolve({ accountId: ACCOUNT }) }),
    unwrap(account).PATCH(request(`/api/composio/accounts/${ACCOUNT}`, "PATCH"), { params: Promise.resolve({ accountId: ACCOUNT }) }),
    unwrap(account).DELETE(request(`/api/composio/accounts/${ACCOUNT}`, "DELETE"), { params: Promise.resolve({ accountId: ACCOUNT }) }),
    unwrap(refresh).POST(request(`/api/composio/accounts/${ACCOUNT}/refresh`, "POST"), { params: Promise.resolve({ accountId: ACCOUNT }) }),
  ]);
  for (const response of responses) {
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Unauthorized" });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});
