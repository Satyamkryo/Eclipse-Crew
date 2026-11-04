import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";

const unwrap = (module) => module.default ?? module;
const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {}, hmrRefresh() {} };
const render = (props) => renderToStaticMarkup(React.createElement(AppRouterContext.Provider, { value: router },
  React.createElement(unwrap(globalThis.__panel), props)));

test("check-ins panel: no agent, then loading state with Sundance/Moondance copy and a New check-in button", async () => {
  const { CheckInsPanel } = unwrap(await import("../components/routines/check-ins-panel.tsx"));
  globalThis.__panel = CheckInsPanel;
  assert.match(render({ csrfToken: "c", timeZone: "UTC" }), /Select an agent to manage its check-ins/);
  const html = render({ agentId: "11111111-1111-4111-8111-111111111111", agentName: "Ada", csrfToken: "c", timeZone: "Asia/Kolkata" });
  assert.match(html, /Sundance and Moondance check-ins/);
  assert.match(html, /Ada only wakes up when something changed/);
  assert.match(html, /New check-in/);
  assert.match(html, /role="status"[^>]*>.*Loading check-ins/s);
  assert.match(html, /Hours use Asia\/Kolkata/);
  assert.match(html, /Open Schedules/);
  assert.doesNotMatch(html, /robotic|bot detection/);
});
