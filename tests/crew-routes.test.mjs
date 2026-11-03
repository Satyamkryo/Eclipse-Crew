import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { crewReportActionSchema, starterCrewPostSchema } from "../lib/crew/schema.ts";
import { chatCardSchema } from "../lib/chat/schema.ts";
import { viewOnlyStreamUrl } from "../lib/desktop/stream.ts";

const unwrap = (module) => module.default ?? module;

test("crew routes expose authenticated read and mutation handlers only", async () => {
  const [starter, status, report] = await Promise.all([
    import("../app/api/crew/starter/route.ts"),
    import("../app/api/crew/status/route.ts"),
    import("../app/api/crew/report/route.ts"),
  ]);
  assert.equal(typeof unwrap(starter).GET, "function");
  assert.equal(typeof unwrap(starter).POST, "function");
  assert.equal(typeof unwrap(status).GET, "function");
  assert.equal(unwrap(status).POST, undefined);
  assert.equal(typeof unwrap(report).GET, "function");
  assert.equal(typeof unwrap(report).POST, "function");
});

test("unauthenticated crew calls fail before reading a body", async () => {
  const starter = unwrap(await import("../app/api/crew/starter/route.ts"));
  const status = unwrap(await import("../app/api/crew/status/route.ts"));
  const report = unwrap(await import("../app/api/crew/report/route.ts"));
  const headers = { Origin: "http://127.0.0.1:3000" };
  const starterPost = await starter.POST(new Request("http://127.0.0.1:3000/api/crew/starter", { method: "POST", headers }));
  assert.equal(starterPost.status, 401);
  assert.deepEqual(await starterPost.json(), { error: "Unauthorized" });
  assert.equal(starterPost.headers.get("cache-control"), "no-store");
  const statusGet = await status.GET(new Request("http://127.0.0.1:3000/api/crew/status"));
  assert.equal(statusGet.status, 401);
  assert.equal(statusGet.headers.get("x-content-type-options"), "nosniff");
  const reportPost = await report.POST(new Request("http://127.0.0.1:3000/api/crew/report", {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ action: "generate" }),
  }));
  assert.equal(reportPost.status, 401);
});

test("crew request schemas are strict and bounded", () => {
  assert.equal(starterCrewPostSchema.safeParse({}).success, true);
  for (const bad of [{ ownerId: randomUUID() }, { members: [] }, { agentId: randomUUID() }, { text: "x" }]) {
    assert.equal(starterCrewPostSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
  assert.equal(crewReportActionSchema.safeParse({ action: "generate" }).success, true);
  assert.equal(crewReportActionSchema.safeParse({ action: "generate", ownerId: randomUUID() }).success, false);
  assert.equal(crewReportActionSchema.safeParse({
    action: "save", enabled: true, recipientAgentId: randomUUID(), localTime: "09:00",
  }).success, true);
  for (const bad of [
    { action: "save", enabled: true, recipientAgentId: randomUUID(), localTime: "9:00" },
    { action: "save", enabled: true, recipientAgentId: "not-a-uuid", localTime: "09:00" },
    { action: "save", enabled: "yes", recipientAgentId: null, localTime: "09:00" },
    { action: "save", enabled: true, recipientAgentId: null, localTime: "24:00" },
    { action: "delete" },
  ]) assert.equal(crewReportActionSchema.safeParse(bad).success, false, JSON.stringify(bad));
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

test("the report path has no model, network or external-mutation call", () => {
  for (const file of ["lib/crew/report.ts", "lib/crew/queue.ts", "lib/crew/time.ts"]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /\bfetch\s*\(/, file);
  }
  const report = readFileSync("lib/crew/report.ts", "utf8");
  assert.doesNotMatch(report, /from "\.\.\/(models|providers|agent|egress)\//);
  assert.doesNotMatch(report, /desktopSession|desktopCommand|recordAudit|sendMessage/);
  const page = readFileSync("app/crew/page.tsx", "utf8");
  assert.match(page, /validateSession\(\)/);
  assert.match(page, /MissionControl/);
  assert.match(page, /StarterCrew/);
  assert.match(page, /ReportSettings/);
  const navigation = readFileSync("components/workspace/app-navigation.tsx", "utf8");
  assert.match(navigation, /href: "\/crew"/);
  assert.match(navigation, /label: "Crew"/);
});
