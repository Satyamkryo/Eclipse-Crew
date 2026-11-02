import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const unwrap = (module) => module.default ?? module;

test("cost and attention routes expose only their read/mutation methods and reject anonymous calls", async () => {
  const [prices, cost, attention] = await Promise.all([
    import("../app/api/models/prices/route.ts"),
    import("../app/api/runs/[runId]/cost/route.ts"),
    import("../app/api/agents/attention/route.ts"),
  ]);
  assert.equal(typeof unwrap(prices).PUT, "function");
  assert.equal(unwrap(prices).GET, undefined);
  assert.equal(typeof unwrap(cost).GET, "function");
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(unwrap(cost)[method], undefined, method);
  assert.equal(typeof unwrap(attention).GET, "function");
  assert.equal(unwrap(attention).POST, undefined);

  const price = await unwrap(prices).PUT(new Request("http://127.0.0.1:3000/api/models/prices", { method: "PUT" }));
  assert.equal(price.status, 401);
  const runId = randomUUID();
  const receipt = await unwrap(cost).GET(new Request(`http://127.0.0.1:3000/api/runs/${runId}/cost`), { params: Promise.resolve({ runId }) });
  assert.equal(receipt.status, 401);
  assert.equal(receipt.headers.get("cache-control"), "no-store");
  const alerts = await unwrap(attention).GET(new Request("http://127.0.0.1:3000/api/agents/attention"));
  assert.equal(alerts.status, 401);
  assert.equal(alerts.headers.get("cache-control"), "no-store");
});
