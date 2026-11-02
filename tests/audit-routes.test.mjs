import assert from "node:assert/strict";
import test from "node:test";

const UUID = "11111111-1111-4111-8111-111111111111";
const unwrap = (module) => module.default ?? module;
const request = (path, method = "GET") => new Request(`http://127.0.0.1:3000${path}`, { method });

test("audit and kill-switch routes expose only authenticated handlers", async () => {
  const [audit, auditExport, stopAgent, stopCrew, resumeCrew] = await Promise.all([
    import("../app/api/audit/route.ts"),
    import("../app/api/audit/export/route.ts"),
    import("../app/api/agents/[agentId]/stop/route.ts"),
    import("../app/api/crew/stop/route.ts"),
    import("../app/api/crew/resume/route.ts"),
  ]);
  assert.equal(typeof unwrap(audit).GET, "function");
  assert.equal(unwrap(audit).POST, undefined);
  assert.equal(typeof unwrap(auditExport).GET, "function");
  assert.equal(unwrap(auditExport).POST, undefined);
  assert.equal(typeof unwrap(stopAgent).POST, "function");
  assert.equal(unwrap(stopAgent).GET, undefined);
  assert.equal(typeof unwrap(stopCrew).POST, "function");
  assert.equal(typeof unwrap(resumeCrew).POST, "function");
});

test("every audit and kill-switch route returns 401 without an owner session", async () => {
  const [audit, auditExport, stopAgent, stopCrew, resumeCrew] = await Promise.all([
    import("../app/api/audit/route.ts"),
    import("../app/api/audit/export/route.ts"),
    import("../app/api/agents/[agentId]/stop/route.ts"),
    import("../app/api/crew/stop/route.ts"),
    import("../app/api/crew/resume/route.ts"),
  ]);
  const responses = await Promise.all([
    unwrap(audit).GET(request("/api/audit")),
    unwrap(auditExport).GET(request("/api/audit/export")),
    unwrap(stopAgent).POST(request(`/api/agents/${UUID}/stop`, "POST"), { params: Promise.resolve({ agentId: UUID }) }),
    unwrap(stopCrew).POST(request("/api/crew/stop", "POST")),
    unwrap(resumeCrew).POST(request("/api/crew/resume", "POST")),
  ]);
  for (const response of responses) {
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Unauthorized" });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});
