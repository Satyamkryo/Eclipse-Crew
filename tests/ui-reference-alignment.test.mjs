// UI reference alignment source checks (prompt 2026-11-03-ui-reference-alignment.md).
// Structural invariants for the shared shell, central tabs and the takeover input policy.
// Rendered visual evidence is captured separately at the reference viewports and recorded
// in docs/TEST_PLAN.md; these checks pin the policy so regressions fail fast.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFile(`${root}${path}`, "utf8");

test("takeover eligibility never uses viewport width, user-agent or maxTouchPoints", async () => {
  const eligibility = await read("components/desktop/use-takeover-eligibility.ts");
  assert.ok(eligibility.includes("(any-pointer: fine)"), "uses the pointer capability hint");
  assert.ok(eligibility.includes("isTrusted"), "requires trusted events");
  assert.ok(eligibility.includes("isComposing"), "rejects composing keyboard events");
  for (const needle of ["maxTouchPoints", "user-agent", "userAgent", "innerWidth", "max-width: 767px"]) {
    assert.ok(!eligibility.includes(needle), `eligibility must not use ${needle}`);
  }
});

test("the live view forwards only real mouse pointers and guards input with eligibility", async () => {
  const liveView = await read("components/desktop/live-view.tsx");
  assert.ok(!liveView.includes("(max-width: 767px)"), "no viewport-based takeover gating");
  assert.ok(liveView.includes('pointerType !== "mouse"'), "touch/pen pointers are ignored for the remote desktop");
  assert.ok(liveView.includes("isTakeoverEligible()"), "takeover and queued input check eligibility");
  assert.ok(liveView.includes("resetTakeoverEvidence()"), "evidence resets on stream loss");
  assert.ok(liveView.includes("takenOver && !eligible"), "eligibility loss releases the lease");
  assert.ok(liveView.includes("Connect a keyboard and mouse"), "compact inline check is named");
});

test("the expanded view shares the same takeover check instead of a phone flag", async () => {
  const expanded = await read("components/desktop/expanded-view.tsx");
  assert.ok(!/phone[:.]/.test(expanded), "no width-based phone prop");
  assert.ok(expanded.includes("takeover"), "uses the shared takeover check");
});

test("the teach recorder can only run during an eligible takeover", async () => {
  const liveView = await read("components/desktop/live-view.tsx");
  assert.match(liveView, /canRecord=\{takenOver && status === "live" && eligible\}/);
});

test("the shared shell renders the reference navigation and the workspace uses central tabs", async () => {
  const nav = await read("components/workspace/app-navigation.tsx");
  for (const label of ["Agents", "Crew", "Jobs", "Evidence", "Models", "MCP Servers", "Settings"]) {
    assert.ok(nav.includes(`label: "${label}"`), `navigation includes ${label}`);
  }
  // The reference's Skills and Schedules entries have no v1 backend: no dead links.
  assert.ok(!nav.includes('label: "Skills"'));
  assert.ok(!nav.includes('label: "Schedules"'));

  const appShell = await read("components/workspace/app-shell.tsx");
  assert.ok(appShell.includes("Control K"), "global search is reachable");
  assert.ok(appShell.includes("SearchPalette"), "the scoped search palette is wired");

  const shell = await read("components/workspace/workspace-shell.tsx");
  assert.ok(shell.includes("WorkspaceCenter"), "center uses the central agent tabs");
  assert.ok(shell.includes("DesktopColumn"), "desktop/activity column exists");
  assert.ok(shell.includes("AppShell"), "workspace composes the shared shell");

  const center = await read("components/workspace/workspace-center.tsx");
  for (const tab of ["Chat", "Settings", "Tools", "Routines", "History", "Memory"]) {
    assert.ok(center.includes(`label: "${tab}"`), `central tab ${tab} exists`);
  }

  const page = await read("app/page.tsx");
  assert.ok(page.includes('variant="sidebar"'), "agent list renders in the shared sidebar");
});

test("the workspace passes a full agent identity to the center heading", async () => {
  const page = await read("app/page.tsx");
  assert.ok(page.includes("role: selectedAgent.role"), "agent heading has the role line");
});

test("every standalone page composes the shared shell", async () => {
  for (const [path, title] of [
    ["app/jobs/page.tsx", "Jobs"],
    ["app/security/page.tsx", "Security Center"],
    ["app/crew/page.tsx", "Crew"],
    ["app/settings/models/page.tsx", "Models"],
    ["app/settings/account/page.tsx", "Account"],
    ["app/settings/connections/page.tsx", "Connections"],
  ]) {
    const source = await read(path);
    assert.ok(source.includes("AppShell"), `${title} uses the shared shell`);
  }
});
