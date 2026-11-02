import assert from "node:assert/strict";
import test from "node:test";

const UUID = "11111111-1111-4111-8111-111111111111";
const unwrap = (module) => module.default ?? module;
const request = (path, method = "GET") => new Request(`http://127.0.0.1:3000${path}`, { method });

test("approval and permission routes expose only authenticated handlers", async () => {
  const [approval, decision, permissions, revoke] = await Promise.all([
    import("../app/api/approvals/[approvalId]/route.ts"),
    import("../app/api/approvals/[approvalId]/decision/route.ts"),
    import("../app/api/agents/[agentId]/permissions/route.ts"),
    import("../app/api/permissions/[permissionId]/revoke/route.ts"),
  ]);
  assert.equal(typeof unwrap(approval).GET, "function");
  assert.equal(unwrap(approval).POST, undefined);
  assert.equal(typeof unwrap(decision).POST, "function");
  assert.equal(unwrap(decision).GET, undefined);
  assert.equal(typeof unwrap(permissions).GET, "function");
  assert.equal(unwrap(permissions).POST, undefined);
  assert.equal(typeof unwrap(revoke).POST, "function");
  assert.equal(unwrap(revoke).GET, undefined);
});

test("every approval route returns 401 without an owner session and never touches the body first", async () => {
  const [approval, decision, permissions, revoke] = await Promise.all([
    import("../app/api/approvals/[approvalId]/route.ts"),
    import("../app/api/approvals/[approvalId]/decision/route.ts"),
    import("../app/api/agents/[agentId]/permissions/route.ts"),
    import("../app/api/permissions/[permissionId]/revoke/route.ts"),
  ]);
  const responses = await Promise.all([
    unwrap(approval).GET(request(`/api/approvals/${UUID}`), { params: Promise.resolve({ approvalId: UUID }) }),
    unwrap(decision).POST(request(`/api/approvals/${UUID}/decision`, "POST"), { params: Promise.resolve({ approvalId: UUID }) }),
    unwrap(permissions).GET(request(`/api/agents/${UUID}/permissions`), { params: Promise.resolve({ agentId: UUID }) }),
    unwrap(revoke).POST(request(`/api/permissions/${UUID}/revoke`, "POST"), { params: Promise.resolve({ permissionId: UUID }) }),
  ]);
  for (const response of responses) {
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Unauthorized" });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});
