import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

const unwrap = (module) => module.default ?? module;

test("agent routes expose only authenticated mutation handlers", async () => {
  const [collection, item, pause, resume] = await Promise.all([
    import("../app/api/agents/route.ts"),
    import("../app/api/agents/[agentId]/route.ts"),
    import("../app/api/agents/[agentId]/pause/route.ts"),
    import("../app/api/agents/[agentId]/resume/route.ts"),
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
});

test("agent lifecycle errors map to safe status codes without leaking details", async () => {
  const http = unwrap(await import("../lib/agents/http.ts"));
  const { AgentLifecycleError } = unwrap(await import("../lib/agents/service.ts"));
  for (const [code, status] of [["agent_not_found", 404], ["confirmation_mismatch", 409], ["desktop_setup_failed", 503]]) {
    const response = http.agentErrorResponse(new AgentLifecycleError(code));
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: code });
  }
  const agentId = randomUUID();
  const unknown = http.agentErrorResponse(new Error(`private ${agentId}`));
  assert.equal(unknown.status, 503);
  assert.deepEqual(await unknown.json(), { error: "service_unavailable" });
});
