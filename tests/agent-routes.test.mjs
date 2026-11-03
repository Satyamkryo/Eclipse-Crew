import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

const unwrap = (module) => module.default ?? module;

test("agent routes expose only authenticated mutation handlers", async () => {
  const [collection, item, pause, resume, astra, desktop] = await Promise.all([
    import("../app/api/agents/route.ts"),
    import("../app/api/agents/[agentId]/route.ts"),
    import("../app/api/agents/[agentId]/pause/route.ts"),
    import("../app/api/agents/[agentId]/resume/route.ts"),
    import("../app/api/agents/[agentId]/astra/route.ts"),
    import("../app/api/agents/[agentId]/desktop/route.ts"),
  ]);
  assert.equal(typeof unwrap(collection).POST, "function");
  assert.equal(unwrap(collection).GET, undefined);
  assert.equal(typeof unwrap(item).PATCH, "function");
  assert.equal(typeof unwrap(item).DELETE, "function");
  assert.equal(unwrap(item).GET, undefined);
  assert.equal(typeof unwrap(pause).POST, "function");
  assert.equal(unwrap(pause).GET, undefined);
  assert.equal(typeof unwrap(resume).POST, "function");
  assert.equal(unwrap(resume).GET, undefined);
  assert.equal(typeof unwrap(astra).POST, "function");
  assert.equal(unwrap(astra).GET, undefined);
  assert.equal(typeof unwrap(desktop).GET, "function");
  assert.equal(typeof unwrap(desktop).POST, "function");
});

test("the desktop lifecycle route rejects an unauthenticated mutation before reading its body", async () => {
  const desktop = unwrap(await import("../app/api/agents/[agentId]/desktop/route.ts"));
  const agentId = randomUUID();
  const response = await desktop.POST(new Request(`http://127.0.0.1:3000/api/agents/${agentId}/desktop`, {
    method: "POST", headers: { Origin: "http://127.0.0.1:3000" },
  }), { params: Promise.resolve({ agentId }) });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
});

test("the Astra route rejects an unauthenticated request without touching the body", async () => {
  const astra = unwrap(await import("../app/api/agents/[agentId]/astra/route.ts"));
  const response = await astra.POST(new Request(`http://127.0.0.1:3000/api/agents/${randomUUID()}/astra`, {
    method: "POST", headers: { Origin: "http://127.0.0.1:3000" },
  }), { params: Promise.resolve({ agentId: randomUUID() }) });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("agent lifecycle errors map to safe status codes without leaking details", async () => {
  const http = unwrap(await import("../lib/agents/http.ts"));
  const { AgentLifecycleError } = unwrap(await import("../lib/agents/service.ts"));
  for (const [code, status] of [["agent_not_found", 404], ["confirmation_mismatch", 409], ["desktop_setup_failed", 503],
    ["budget_exhausted", 409], ["crew_stopped", 409], ["agent_paused", 409], ["security_stopped", 409],
    ["desktop_start_failed", 503], ["browser_start_failed", 503], ["profile_busy_or_unsafe", 503], ["display_conflict", 503]]) {
    const response = http.agentErrorResponse(new AgentLifecycleError(code));
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: code });
  }
  const agentId = randomUUID();
  const unknown = http.agentErrorResponse(new Error(`private ${agentId}`));
  assert.equal(unknown.status, 503);
  assert.deepEqual(await unknown.json(), { error: "service_unavailable" });
});
