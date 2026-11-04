import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { starterCrewPostSchema } from "../lib/crew/schema.ts";
import { chatCardSchema } from "../lib/chat/schema.ts";
import { viewOnlyStreamUrl } from "../lib/desktop/stream.ts";

const unwrap = (module) => module.default ?? module;

test("crew routes expose authenticated read and mutation handlers only", async () => {
  const [starter, status] = await Promise.all([
    import("../app/api/crew/starter/route.ts"),
    import("../app/api/crew/status/route.ts"),
  ]);
  assert.equal(typeof unwrap(starter).GET, "function");
  assert.equal(typeof unwrap(starter).POST, "function");
  assert.equal(typeof unwrap(status).GET, "function");
  assert.equal(unwrap(status).POST, undefined);
});

test("unauthenticated crew calls fail before reading a body", async () => {
  const starter = unwrap(await import("../app/api/crew/starter/route.ts"));
  const status = unwrap(await import("../app/api/crew/status/route.ts"));
  const headers = { Origin: "http://127.0.0.1:3000" };
  const starterPost = await starter.POST(new Request("http://127.0.0.1:3000/api/crew/starter", { method: "POST", headers }));
  assert.equal(starterPost.status, 401);
  assert.deepEqual(await starterPost.json(), { error: "Unauthorized" });
  assert.equal(starterPost.headers.get("cache-control"), "no-store");
  const statusGet = await status.GET(new Request("http://127.0.0.1:3000/api/crew/status"));
  assert.equal(statusGet.status, 401);
  assert.equal(statusGet.headers.get("x-content-type-options"), "nosniff");
});

test("crew request schemas are strict and bounded", () => {
  assert.equal(starterCrewPostSchema.safeParse({}).success, true);
  for (const bad of [{ ownerId: randomUUID() }, { members: [] }, { agentId: randomUUID() }, { text: "x" }]) {
    assert.equal(starterCrewPostSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("the view-only thumbnail rechecks stream state before opening a desktop socket", async () => {
  const agentId = randomUUID();
  const connectionId = randomUUID();
  const httpUrl = `http://127.0.0.1:3000/api/desktop/${agentId}/stream?connectionId=${connectionId}`;
  const ok = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });
  assert.equal(
    await viewOnlyStreamUrl(httpUrl, ok({ state: "running", graphics: "running", generation: randomUUID() })),
    `ws://127.0.0.1:3000/api/desktop/${agentId}/stream?connectionId=${connectionId}`,
  );
  const unavailable = [
    ok({ state: "stopped", graphics: "stopped" }, 409),
    ok({ state: "running", graphics: "stopped", generation: randomUUID() }),
    ok({ state: "running", graphics: "running", generation: "not-a-uuid" }),
    ok({ state: "running", graphics: "running" }),
    async () => new Response("nope", { status: 200 }),
    async () => { throw new Error("offline"); },
  ];
  for (const fetchImpl of unavailable) {
    await assert.rejects(() => viewOnlyStreamUrl(httpUrl, fetchImpl), /stream_unavailable/);
  }
  const thumbnail = readFileSync("components/crew/desktop-thumbnail.tsx", "utf8");
  assert.match(thumbnail, /viewOnlyStreamUrl\(/);
  assert.match(thumbnail, /new RFB\(stageRef\.current!, streamHref\)/);
});

test("a crew report card is validated text and safe identifiers only", () => {
  const valid = {
    type: "crew_report",
    windowStart: "2026-11-02T03:30:00.000Z",
    windowEnd: "2026-11-03T03:30:00.000Z",
    timezone: "Asia/Kolkata",
    counts: { completed: 1, running: 0, interrupted: 0, failed: 0, needsYou: 0 },
    totalRuns: 1,
    costMicroUsd: 120,
    runs: [{
      runId: randomUUID(), agentId: randomUUID(), agentName: "Briefer",
      label: "<b>not html</b>", outcome: "verified", outcomeLabel: "Verified", sealed: true,
    }],
  };
  assert.equal(chatCardSchema.safeParse(valid).success, true);
  for (const bad of [
    { ...valid, url: "https://evil.example" },
    { ...valid, runs: [{ ...valid.runs[0], runId: "not-a-uuid" }] },
    { ...valid, runs: Array.from({ length: 11 }, () => valid.runs[0]) },
    { ...valid, counts: { ...valid.counts, extra: 1 } },
    { ...valid, runs: [{ ...valid.runs[0], outcome: "trusted" }] },
    { ...valid, costMicroUsd: -1 },
  ]) assert.equal(chatCardSchema.safeParse(bad).success, false, JSON.stringify(bad));
});

test("crew and Mission Control pages are session-gated and the morning report is gone", () => {
  // The morning report was replaced by Schedules: no settings UI, route, queue or scheduler tick remains.
  for (const file of ["lib/crew/report.ts", "lib/crew/queue.ts", "app/api/crew/report/route.ts", "components/crew/report-settings.tsx"]) {
    assert.throws(() => readFileSync(file, "utf8"), /ENOENT/, file);
  }
  const scheduler = readFileSync("lib/routines/scheduler.ts", "utf8");
  assert.doesNotMatch(scheduler, /CrewReport|crew\/report|crew\/queue/);
  assert.doesNotMatch(readFileSync("lib/crew/time.ts", "utf8"), /\bfetch\s*\(/);
  const page = readFileSync("app/crew/page.tsx", "utf8");
  assert.match(page, /validateSession\(\)/);
  assert.match(page, /StarterCrew/);
  assert.match(page, /CustomCrews/);
  assert.doesNotMatch(page, /ReportSettings/);
  const missionControl = readFileSync("app/mission-control/page.tsx", "utf8");
  assert.match(missionControl, /validateSession\(\)/);
  assert.match(missionControl, /MissionControl/);
  const navigation = readFileSync("components/workspace/app-navigation.tsx", "utf8");
  assert.match(navigation, /href: "\/crew"/);
  assert.match(navigation, /label: "Crew"/);
});
