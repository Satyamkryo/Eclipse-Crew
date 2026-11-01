import assert from "node:assert/strict";
import test from "node:test";

const unwrap = (module) => module.default ?? module;

test("model routes expose only authenticated mutation handlers", async () => {
  const [roles, testRoute] = await Promise.all([
    import("../app/api/models/roles/[role]/route.ts"),
    import("../app/api/models/test/route.ts"),
  ]);
  assert.equal(typeof unwrap(roles).PUT, "function");
  assert.equal(unwrap(roles).GET, undefined);
  assert.equal(unwrap(roles).POST, undefined);
  assert.equal(typeof unwrap(testRoute).POST, "function");
  assert.equal(unwrap(testRoute).GET, undefined);
});

test("model errors map to bounded safe responses", async () => {
  const http = unwrap(await import("../lib/models/http.ts"));
  const errors = unwrap(await import("../lib/models/errors.ts"));
  for (const [code, status] of [
    ["invalid_input", 400],
    ["key_required", 400],
    ["sam_depends_on_main_key", 409],
    ["authenticated_transport_unavailable", 503],
    ["provider_test_failed", 502],
  ]) {
    const response = http.modelErrorResponse(new errors.ModelSettingsError(code, status));
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: code });
  }
  const unknown = http.modelErrorResponse(new Error("private CANARY detail"));
  assert.equal(unknown.status, 503);
  assert.deepEqual(await unknown.json(), { error: "service_unavailable" });
});
