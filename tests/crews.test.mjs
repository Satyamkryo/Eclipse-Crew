import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { getTableName } from "drizzle-orm";

import { cleanupCrewDatabase, createCrewDatabase, insertOwner } from "./crew-db.mjs";

const unwrap = (module) => module.default ?? module;

const handle = await createCrewDatabase();
test.after(() => cleanupCrewDatabase(handle));

test("crew tables are owner-scoped with the expected columns", async () => {
  const schema = unwrap(await import("../db/schema.ts"));
  assert.equal(getTableName(schema.crews), "crews");
  assert.equal(getTableName(schema.crewMembers), "crew_members");
  assert.deepEqual(
    ["id", "ownerId", "name", "description", "createdAt", "updatedAt"].map((field) => schema.crews[field].name),
    ["id", "owner_id", "name", "description", "created_at", "updated_at"],
  );
  assert.deepEqual(
    ["id", "ownerId", "crewId", "agentId", "agentName", "role", "state", "errorCode", "createdAt", "updatedAt"]
      .map((field) => schema.crewMembers[field].name),
    ["id", "owner_id", "crew_id", "agent_id", "agent_name", "role", "state", "error_code", "created_at", "updated_at"],
  );
});

test("crew creation validates names, size and uniqueness", async () => {
  const { crewCreateSchema } = unwrap(await import("../lib/crew/custom.ts"));
  const member = (name, role = "Researcher") => ({ name, role });
  assert.ok(crewCreateSchema.safeParse({
    name: "Watchers", description: "Watches things",
    members: [member("Milly"), { name: "Lilly", role: "Writer", soulMd: "Be terse.", dailyBudgetUsd: "2.50", monthlyBudgetUsd: "20" }],
  }).success);
  assert.ok(crewCreateSchema.safeParse({ name: "Watchers", members: [member("Milly")] }).success);
  for (const invalid of [
    { name: "", members: [member("Milly")] },
    { name: "x".repeat(81), members: [member("Milly")] },
    { name: "Watchers", members: [] },
    { name: "Watchers", members: Array.from({ length: 7 }, (_, index) => member(`Agent ${index}`)) },
    { name: "Watchers", members: [member("Milly"), member("milly")] },
    { name: "Watchers", members: [{ name: "Milly", role: "" }] },
    { name: "Watchers", members: [{ name: "Milly", role: "R", dailyBudgetUsd: "abc" }] },
    { name: "Watchers", members: [{ name: "Milly", role: "R", dailyBudgetUsd: "0.00" }] },
    { name: "Watchers", members: [{ name: "Milly", role: "R", monthlyBudgetUsd: "0" }] },
    { name: "Watchers", members: [{ name: "Milly", role: "R", soulMd: "bad\u0000persona" }] },
  ]) assert.equal(crewCreateSchema.safeParse(invalid).success, false, JSON.stringify(invalid));
  const parsed = crewCreateSchema.safeParse({ name: "Watchers", members: [{ name: "Milly", role: "R", soulMd: "line one\nline two", dailyBudgetUsd: "0.01" }] });
  assert.ok(parsed.success);
  assert.equal(parsed.data.members[0].dailyBudgetUsd, 1);
  const invalidPersona = crewCreateSchema.safeParse({ name: "Watchers", members: [{ name: "Milly", role: "R", soulMd: "a\u0000b" }] });
  assert.deepEqual(invalidPersona.error.issues[0].path, ["members", 0, "soulMd"]);
});

test("crew members fill persona, budgets, tools and actions from safe defaults", async () => {
  const { crewMemberCreateInput } = unwrap(await import("../lib/crew/custom.ts"));
  const minimal = crewMemberCreateInput({ name: "Milly", role: "Competitive researcher" });
  assert.equal(minimal.name, "Milly");
  assert.equal(minimal.role, "Competitive researcher");
  // ADR-036. A blank member gets role-based expert instructions and an empty persona.
  assert.match(minimal.instructions, /Milly/);
  assert.match(minimal.instructions, /Competitive researcher/);
  assert.equal(minimal.soulMd, "");
  assert.equal(minimal.anyPublicWeb, true);
  assert.equal(minimal.dailyBudgetCents, 500);
  assert.equal(minimal.monthlyBudgetCents, 5000);
  assert.deepEqual(minimal.tools, ["read_document", "deliver_file"]);
  assert.deepEqual(minimal.domains, []);
  assert.ok(minimal.actions.includes("handoff"));
  assert.ok(minimal.actions.includes("click"));
  assert.ok(!minimal.actions.includes("tool_call"));
  assert.ok(!minimal.actions.includes("shell"));
  assert.deepEqual(minimal.memoryScopes, ["global", "agent"]);
  const explicit = crewMemberCreateInput({
    name: "Lilly", role: "Writer", soulMd: "Be terse.", dailyBudgetUsd: 250, monthlyBudgetUsd: 2000,
  });
  assert.equal(explicit.soulMd, "Be terse.");
  assert.equal(explicit.dailyBudgetCents, 250);
  assert.equal(explicit.monthlyBudgetCents, 2000);
});

test("handoff stays inside a shared crew and is refused for a standard agent", async () => {
  const { shareCrew } = unwrap(await import("../lib/crew/custom.ts"));
  const database = (senderCrews, receiverCrews) => {
    let calls = 0;
    const lists = [senderCrews, receiverCrews];
    return { select: () => ({ from: () => ({ where: () => lists[calls++].map((crewId) => ({ crewId })) }) }) };
  };
  // ADR-036. Sender in no crew (a standard agent): never hands off on its own.
  assert.equal(await shareCrew(database([], ["a"]), "owner", "s", "r"), false);
  assert.equal(await shareCrew(database([], []), "owner", "s", "r"), false);
  // Shared crew: allowed.
  assert.equal(await shareCrew(database(["a", "b"], ["b"]), "owner", "s", "r"), true);
  // Different crews: refused.
  assert.equal(await shareCrew(database(["a"], ["b"]), "owner", "s", "r"), false);
  assert.equal(await shareCrew(database(["a"], []), "owner", "s", "r"), false);
});

// ADR-036. The starter crew and custom crews are both crews; an agent in neither has no crewmates.
test("crew groups count the starter crew and custom crews; standard agents have no crewmates", async () => {
  const { listCrewGroups, crewmateIds } = unwrap(await import("../lib/crew/groups.ts"));
  const starterRows = [{ agentId: "s1" }, { agentId: "s2" }];
  const customRows = [{ crewId: "c1", name: "Market watch", agentId: "m1" }, { crewId: "c1", name: "Market watch", agentId: "m2" }];
  const database = {
    select: () => ({
      from: () => ({
        where: async () => starterRows,
        innerJoin: () => ({ where: () => ({ orderBy: async () => customRows }) }),
      }),
    }),
  };
  const groups = await listCrewGroups(database, "owner");
  assert.deepEqual(groups.map((group) => [group.key, group.name, group.agentIds]),
    [["starter", "Starter crew", ["s1", "s2"]], ["c1", "Market watch", ["m1", "m2"]]]);
  assert.deepEqual([...await crewmateIds(database, "owner", "s1")], ["s2"]);
  assert.deepEqual([...await crewmateIds(database, "owner", "m2")], ["m1"]);
  assert.equal((await crewmateIds(database, "owner", "standalone")).size, 0);
});

test("a custom crew creates ready agents with defaults on a real database", { timeout: 120000 }, async () => {
  if (handle.skip) return;
  const { createCrew, getCrew, listCrews, crewIdsForAgent, shareCrew } = unwrap(await import("../lib/crew/custom.ts"));
  const owner = await insertOwner(handle.adminPool);
  const fakeDesktop = {
    desktopCreateAgent: async () => ({ agentId: "x" }),
    desktopDeleteAgent: async () => ({ agentId: "x" }),
    desktopSession: async (agentId) => ({ agentId, state: "running", generation: randomUUID() }),
  };
  const created = await createCrew(handle.app, owner, {
    name: "Watchers",
    description: "Watches things",
    members: [
      { name: "Milly", role: "Competitive researcher" },
      { name: "Lilly", role: "Writer", soulMd: "Be terse.", dailyBudgetUsd: 250, monthlyBudgetUsd: 2000 },
    ],
  }, fakeDesktop);
  assert.equal(created.name, "Watchers");
  assert.deepEqual(created.summary, { total: 2, ready: 2, failed: 0, inProgress: 0 });
  const milly = created.members.find((member) => member.agentName === "Milly");
  const lilly = created.members.find((member) => member.agentName === "Lilly");
  assert.ok(milly && lilly);
  assert.equal(milly.role, "Competitive researcher");
  assert.match(milly.state, /ready/);
  const reread = await getCrew(handle.app, owner, created.id);
  assert.equal(reread?.members.length, 2);
  const listed = await listCrews(handle.app, owner);
  assert.equal(listed.length, 1);
  assert.deepEqual(await crewIdsForAgent(handle.app, owner, milly.agentId), [created.id]);
  assert.equal(await shareCrew(handle.app, owner, milly.agentId, lilly.agentId), true);
  const outsider = randomUUID();
  assert.equal(await shareCrew(handle.app, owner, milly.agentId, outsider), false);
  // ADR-036. An agent in no crew never hands off on its own.
  assert.equal(await shareCrew(handle.app, owner, outsider, lilly.agentId), false);
});

test("a failed or abandoned member is retried with the same agent; a live setup is never taken over", { timeout: 120000 }, async () => {
  if (handle.skip) return;
  const { createCrew, getCrew, retryCrew, STALE_CLAIM_MS } = unwrap(await import("../lib/crew/custom.ts"));
  // TASK-092. Reuse the owner an earlier test created, or create it.
  const existing = await handle.adminPool.query("SELECT id FROM owner LIMIT 1");
  const owner = existing.rows[0]?.id ?? await insertOwner(handle.adminPool);
  const started = [];
  const desktop = (failing) => ({
    desktopCreateAgent: async () => ({ agentId: "x" }),
    desktopDeleteAgent: async () => ({ agentId: "x" }),
    desktopSession: async (agentId) => {
      started.push(agentId);
      if (failing.has(agentId)) throw new Error("desktop_start_failed");
      return { agentId, state: "running", generation: randomUUID() };
    },
  });
  // First create: Lilly's desktop fails (the failing set is filled once her preallocated id is known).
  const failing = new Set();
  const flaky = desktop(failing);
  const originalSession = flaky.desktopSession;
  let calls = 0;
  flaky.desktopSession = async (agentId) => { if (++calls === 2) failing.add(agentId); return originalSession(agentId); };
  const created = await createCrew(handle.app, owner, {
    name: "Retriers",
    members: [
      { name: "Milly", role: "Researcher" },
      { name: "Lilly", role: "Writer", soulMd: "Be terse.", dailyBudgetUsd: 250 },
    ],
  }, flaky);
  assert.equal(created.summary.ready, 1);
  assert.equal(created.summary.failed, 1);
  assert.equal(created.retryable, true, "a failed member offers Retry");
  const lilly = created.members.find((member) => member.state === "failed");
  const milly = created.members.find((member) => member.state === "ready");

  // Retry: only the failed member is set up again, under the same agent id, and keeps its saved persona/budget.
  started.length = 0;
  const retried = await retryCrew(handle.app, owner, created.id, desktop(new Set()));
  assert.deepEqual(started, [lilly.agentId], "only the failed member is retried");
  assert.deepEqual(retried.summary, { total: 2, ready: 2, failed: 0, inProgress: 0 });
  assert.equal(retried.retryable, false);
  assert.equal(retried.members.find((member) => member.memberId === lilly.memberId).agentId, lilly.agentId);
  const saved = await handle.adminPool.query("SELECT soul_md, daily_budget_cents FROM agents WHERE id = $1", [lilly.agentId]);
  assert.equal(saved.rows[0].soul_md, "Be terse.");
  assert.equal(saved.rows[0].daily_budget_cents, 250);

  // A member that is `creating` right now (a live setup) is left alone and does not offer Retry.
  await handle.adminPool.query("UPDATE crew_members SET state = 'creating', updated_at = now() WHERE id = $1", [milly.memberId]);
  started.length = 0;
  const live = await retryCrew(handle.app, owner, created.id, desktop(new Set()));
  assert.deepEqual(started, [], "a live claim is never taken over");
  assert.equal(live.retryable, false);
  assert.equal(live.members.find((member) => member.memberId === milly.memberId).state, "creating");

  // Abandoned (the app restarted mid-setup): older than the stale window, so Retry offers and reclaims it.
  const old = new Date(Date.now() - STALE_CLAIM_MS - 60_000);
  await handle.adminPool.query("UPDATE crew_members SET updated_at = $2 WHERE id = $1", [milly.memberId, old]);
  assert.equal((await getCrew(handle.app, owner, created.id)).retryable, true, "an abandoned member offers Retry");
  const resumed = await retryCrew(handle.app, owner, created.id, desktop(new Set()));
  assert.deepEqual(started, [milly.agentId]);
  assert.equal(resumed.members.find((member) => member.memberId === milly.memberId).state, "ready");
  assert.equal(resumed.members.find((member) => member.memberId === milly.memberId).agentId, milly.agentId);

  // Another owner id can neither see nor retry this crew (every query is scoped by owner_id).
  started.length = 0;
  assert.equal(await retryCrew(handle.app, randomUUID(), created.id, desktop(new Set())), null);
  assert.deepEqual(started, []);
});

test("the crew retry route requires the owner session before reading a body", async () => {
  const route = unwrap(await import("../app/api/crews/[crewId]/route.ts"));
  assert.equal(typeof route.POST, "function");
  const crewId = randomUUID();
  const response = await route.POST(new Request(`http://127.0.0.1:3000/api/crews/${crewId}`, {
    method: "POST", headers: { Origin: "http://127.0.0.1:3000", "Content-Type": "application/json" }, body: "{}",
  }), { params: Promise.resolve({ crewId }) });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("crew migration and runtime grants are explicitly allowlisted", () => {
  const provision = readFileSync("db/provision.sql", "utf8");
  for (const table of ["'crews'", "'crew_members'"]) {
    assert.match(provision, new RegExp(`${table.replace(/'/g, "'")}`), `${table} is an allowed provision object`);
  }
  assert.match(provision, /GRANT SELECT, INSERT, UPDATE ON public\.crews TO eclipse_app/);
  assert.match(provision, /GRANT SELECT, INSERT, UPDATE ON public\.crew_members TO eclipse_app/);
  const migrate = readFileSync("scripts/db-migrate.mjs", "utf8");
  assert.match(migrate, /GRANT SELECT, INSERT, UPDATE ON public\.crews TO eclipse_app/);
  assert.match(migrate, /GRANT SELECT, INSERT, UPDATE ON public\.crew_members TO eclipse_app/);
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
  assert.ok(journal.entries.some((entry) => String(entry.tag).includes("0035")), "0035 migration is journaled");
});
