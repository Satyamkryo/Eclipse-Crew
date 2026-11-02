import assert from "node:assert/strict";
import test from "node:test";

import { createCostedConnector } from "../lib/costs/runtime.ts";
import { CostStopError } from "../lib/costs/types.ts";

const usage = { inputTokens: 10, outputTokens: 2, cachedInputTokens: 1, reasoningTokens: 0 };
const result = { id: "r", model: "model", status: "completed", incompleteReason: null, outputs: [], text: "", usage };
const request = { model: "model", messages: [{ role: "user", content: [{ type: "text", text: "Hi", sourceTag: "user" }] }] };

function sink({ before = async () => {}, record = async () => {}, total = 0 } = {}) {
  const events = [];
  return { events, costs: {
    async beforeCall(call) { events.push(["before", call]); return before(call); },
    async recordCall(call) { events.push(["record", call]); return record(call); },
    totalMicroUsd: () => total,
  } };
}

test("a costed connector records one successful call and one failed call", async () => {
  let calls = 0;
  const provider = { kind: "meta", listModels: async () => [], detectCapabilities: async () => ({}),
    generate: async () => { calls += 1; if (calls === 2) throw Object.assign(new Error("down"), { code: "provider_unavailable" }); return result; } };
  const { costs, events } = sink();
  const connector = createCostedConnector(provider, costs, { providerId: "provider", kind: "meta", baseUrl: null });
  assert.deepEqual(await connector.generate(request), result);
  await assert.rejects(connector.generate(request), /down/);
  assert.deepEqual(events.map(([kind]) => kind), ["before", "record", "before", "record"]);
  assert.deepEqual(events[1][1].usage, { inputTokens: 10, outputTokens: 2, cachedInputTokens: 1 });
  assert.equal(events[1][1].outcome, "completed");
  assert.equal(events[3][1].outcome, "provider_unavailable");
  assert.deepEqual(events[3][1].usage, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
});

test("budget and price stops happen before the provider request", async () => {
  let providerCalls = 0;
  const provider = { kind: "meta", listModels: async () => [], detectCapabilities: async () => ({}), generate: async () => { providerCalls += 1; return result; } };
  const { costs } = sink({ before: async () => { throw new CostStopError("price_required"); } });
  const connector = createCostedConnector(provider, costs, { providerId: "provider", kind: "meta", baseUrl: null });
  await assert.rejects(connector.generate(request), (error) => error.code === "price_required");
  assert.equal(providerCalls, 0);

  const failing = sink({ record: async () => { throw new CostStopError("cost_error"); } });
  const strict = createCostedConnector(provider, failing.costs, { providerId: "provider", kind: "meta", baseUrl: null });
  await assert.rejects(strict.generate(request), (error) => error.code === "cost_error");
});
