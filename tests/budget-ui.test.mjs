import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";

const unwrap = (module) => module.default ?? module;
const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {}, hmrRefresh() {} };
const render = (element) => renderToStaticMarkup(React.createElement(AppRouterContext.Provider, { value: router }, element));

test("the price table shows exact rates, built-in/local labels and the unpriced warning", async () => {
  const { PriceTable } = unwrap(await import("../app/settings/models/price-table.tsx"));
  const rows = [
    { providerId: "11111111-1111-4111-8111-111111111111", providerLabel: "Meta Model API", kind: "meta", baseUrl: null,
      model: "muse-spark-1.3", role: "main",
      price: { inputMicroUsdPerMillion: 1_250_000, cachedMicroUsdPerMillion: 150_000, outputMicroUsdPerMillion: 4_250_000, imageMicroUsdPerThousand: 0 }, source: "default" },
    { providerId: "22222222-2222-4222-8222-222222222222", providerLabel: "https://api.example.com/v1", kind: "openai-compatible", baseUrl: "https://api.example.com/v1",
      model: "hosted-model", role: "hard", price: null, source: "unpriced" },
  ];
  const html = render(React.createElement(PriceTable, { initial: rows, csrfToken: "csrf" }));
  assert.match(html, /muse-spark-1\.3/); assert.match(html, /value="1\.25"/); assert.match(html, /value="0\.15"/); assert.match(html, /value="4\.25"/);
  assert.match(html, /Input per 1M/); assert.match(html, /Images per 1K/); assert.match(html, /hosted-model/);
  assert.match(html, /Needs price/); assert.match(html, /until it has a price/);
  assert.doesNotMatch(html, /Audio per hour/, "voice transcription isn't shipped, so no audio column");
});

test("an agent with budget attention gets the corona ring and the words Needs you", async () => {
  const { AgentPane } = unwrap(await import("../components/workspace/agent-pane.tsx"));
  const html = render(React.createElement(AgentPane, {
    csrfToken: "csrf", selectedAgentId: "11111111-1111-4111-8111-111111111111",
    agents: [
      { id: "11111111-1111-4111-8111-111111111111", name: "Ada", role: "Researcher", status: "paused", attention: "budget_paused" },
      { id: "22222222-2222-4222-8222-222222222222", name: "Bo", role: "Researcher", status: "paused", attention: null },
    ],
  }));
  assert.match(html, /ring-corona/);
  assert.match(html, /Needs you/);
  assert.match(html, />Paused</, "an ordinary paused agent keeps its paused label");
  assert.match(html, /aria-label="Agents"/);
});
