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

test("takeover availability uses only the pointer capability hint", async () => {
  const availability = await read("components/desktop/use-takeover-eligibility.ts");
  assert.ok(availability.includes("(any-pointer: fine)"), "uses the pointer capability hint");
  for (const needle of ["maxTouchPoints", "user-agent", "userAgent", "innerWidth", "max-width: 767px"]) {
    assert.ok(!availability.includes(needle), `availability must not use ${needle}`);
  }
});

test("take over is one click: no Enter confirmation, and only real mouse pointers drive the desktop", async () => {
  const liveView = await read("components/desktop/live-view.tsx");
  const expanded = await read("components/desktop/expanded-view.tsx");
  assert.ok(!liveView.includes("(max-width: 767px)"), "no viewport-based takeover gating");
  assert.ok(liveView.includes('pointerType !== "mouse"'), "touch/pen pointers are ignored for the remote desktop");
  for (const source of [liveView, expanded]) {
    assert.ok(!source.includes("Press Enter to confirm"), "no Enter confirmation step");
    assert.ok(!source.includes("awaitingKey"), "no keyboard evidence step");
  }
  assert.ok(liveView.includes("onClick={() => void takeOver()}"), "the inline button takes over on click");
  assert.ok(expanded.includes("onClick={onTakeOver}"), "the full-screen button takes over on click");
  assert.ok(!/phone[:.]/.test(expanded), "no width-based phone prop");
});

test("the takeover views no longer show the recording controls", async () => {
  const liveView = await read("components/desktop/live-view.tsx");
  const expanded = await read("components/desktop/expanded-view.tsx");
  assert.ok(!liveView.includes("TeachControls") && !liveView.includes("useTeachCapture"));
  assert.ok(!expanded.includes("teachControls"));
});

test("the shared shell renders the reference navigation and the workspace uses central tabs", async () => {
  const nav = await read("components/workspace/app-navigation.tsx");
  // Nov 4 restructure: Jobs merged into Mission Control (Runs), MCP servers live under Connectors,
  // GitHub + Composio API keys live under Integrations, Schedules has its own page,
  // Account moved to Profile (header chip).
  for (const label of ["Agents", "Crew", "Mission Control", "Models", "Connectors", "Integrations", "Schedules", "Security"]) {
    assert.ok(nav.includes(`label: "${label}"`), `navigation includes ${label}`);
  }
  // Run history lives in each agent workspace's History tab, not the sidebar: without an agent the link
  // could only land on the agent gallery.
  assert.ok(!nav.includes('label: "Evidence"'));
  // Skills has no v1 backend: no dead link. Jobs is a redirect, not a nav entry.
  assert.ok(!nav.includes('label: "Skills"'));
  assert.ok(!nav.includes('label: "Jobs"'));

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
  // The sidebar + top bar mount once in the route-group layout, so navigating
  // swaps only the main area instead of remounting the whole shell per page.
  const layout = await read("app/(app)/layout.tsx");
  assert.ok(layout.includes("ShellChrome"), "route-group layout renders the persistent shell");
  const chrome = await read("components/workspace/shell-chrome.tsx");
  assert.ok(chrome.includes("AppShell"), "persistent shell renders the shared AppShell");
  for (const [path, title] of [
    ["app/(app)/mission-control/page.tsx", "Mission Control"],
    ["app/(app)/schedules/page.tsx", "Schedules"],
    ["app/(app)/security/page.tsx", "Security Center"],
    ["app/(app)/crew/page.tsx", "Crew"],
    ["app/(app)/profile/page.tsx", "Profile"],
    ["app/(app)/settings/models/page.tsx", "Models"],
    ["app/(app)/settings/connections/page.tsx", "Connectors"],
    ["app/(app)/settings/integrations/page.tsx", "Integrations"],
    ["app/(app)/jobs/[runId]/page.tsx", "Run detail"],
  ]) {
    const source = await read(path);
    assert.ok(!source.includes("AppShell"), `${title} renders inner content only (shell persists in layout)`);
  }
  // Old addresses stay as redirects for bookmarks.
  assert.match(await read("app/(app)/jobs/page.tsx"), /redirect\(`\/mission-control\$\{query\}`\)/);
  assert.match(await read("app/(app)/settings/account/page.tsx"), /redirect\("\/profile"\)/);
});
