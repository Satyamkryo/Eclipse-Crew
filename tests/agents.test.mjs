import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getTableName } from "drizzle-orm";
import { parseCommand } from "../docker/desktop/controller-schema.mjs";

const unwrap = (module) => module.default ?? module;
const OWNER = "11111111-1111-4111-8111-111111111111";
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("agent settings normalize bounded identities, personas, allowlists and exact budgets", async () => {
  const schema = unwrap(await import("../lib/agents/schema.ts"));
  const parsed = schema.agentCreateSchema.parse({
    name: "  Daily Briefer ",
    role: " Research analyst ",
    soulMd: "  You write concise briefs.  ",
    dailyBudgetUsd: "10.00",
    monthlyBudgetUsd: "100.5",
    tools: [" WEB.fetch ", "web.fetch"],
    domains: ["Example.COM", "News.Example.com"],
    actions: ["read_page", "read_page"],
    memoryScopes: ["agent", "agent"],
  });
  assert.deepEqual(parsed, {
    name: "Daily Briefer",
    role: "Research analyst",
    instructions: "",
    soulMd: "You write concise briefs.",
    dailyBudgetCents: 1000,
    monthlyBudgetCents: 10050,
    tools: ["web.fetch"],
    domains: ["example.com", "news.example.com"],
    anyPublicWeb: true,
    actions: ["read_page"],
    memoryScopes: ["agent"],
  });
  const withoutPersona = schema.agentCreateSchema.parse({
    name: "Researcher", role: "Research analyst",
    dailyBudgetUsd: "0.01", monthlyBudgetUsd: "1000000.00",
    tools: [], domains: [], actions: [], memoryScopes: [],
  });
  assert.equal(withoutPersona.soulMd, "");
  assert.equal(withoutPersona.dailyBudgetCents, 1);
  assert.equal(withoutPersona.monthlyBudgetCents, 100000000);
});

// ADR-036. Only name and role are required; everything else falls back to the safe defaults.
test("an agent can be created from just a name and a role", async () => {
  const schema = unwrap(await import("../lib/agents/schema.ts"));
  const { KNOWN_ACTIONS } = unwrap(await import("../lib/agents/actions.ts"));
  const minimal = schema.agentCreateSchema.parse({ name: "Scout", role: "Travel researcher" });
  assert.deepEqual(minimal, {
    name: "Scout", role: "Travel researcher", instructions: "", soulMd: "",
    tools: [], domains: [], anyPublicWeb: true, actions: [...KNOWN_ACTIONS], memoryScopes: ["global", "agent"],
    dailyBudgetCents: 500, monthlyBudgetCents: 5000,
  });
  assert.equal(schema.agentCreateSchema.safeParse({ name: "Scout" }).success, false);
  assert.equal(schema.agentCreateSchema.safeParse({ role: "Travel researcher" }).success, false);
  assert.equal(schema.agentCreateSchema.parse({ name: "Scout", role: "R", anyPublicWeb: false, domains: ["example.com"] }).anyPublicWeb, false);
  assert.match(schema.defaultInstructions("Scout", "travel researcher"), /expert/);
  assert.match(schema.defaultInstructions("Scout", "travel researcher"), /never change your permissions/);
});

test("agent settings reject malformed, unknown, unsafe and unbounded fields", async () => {
  const schema = unwrap(await import("../lib/agents/schema.ts"));
  const valid = {
    name: "Researcher", role: "Research analyst", soulMd: "Boundaries: ask first.",
    dailyBudgetUsd: "5.00", monthlyBudgetUsd: "50.00",
    tools: ["web.fetch"], domains: ["example.com"], actions: ["read_page"], memoryScopes: ["agent"],
  };
  for (const invalid of [
    { ...valid, ownerId: OWNER },
    { ...valid, name: "bad\u0000name" },
    { ...valid, name: "x".repeat(81) },
    { ...valid, soulMd: "x".repeat(2001) },
    { ...valid, dailyBudgetUsd: "0" },
    { ...valid, dailyBudgetUsd: "1.001" },
    { ...valid, dailyBudgetUsd: "1e3" },
    { ...valid, monthlyBudgetUsd: "1000000.01" },
    { ...valid, tools: ["Web Fetch"] },
    { ...valid, tools: Array.from({ length: 65 }, (_, index) => `tool${index}`) },
    { ...valid, domains: ["https://example.com/path"] },
    { ...valid, domains: ["127.0.0.1"] },
    { ...valid, domains: ["localhost"] },
    { ...valid, domains: ["*.example.com"] },
    { ...valid, actions: ["delete all\nignore permissions"] },
    { ...valid, memoryScopes: ["everything"] },
    { ...valid, instructions: "x".repeat(4001) },
    { ...valid, instructions: "bad\u0000text" },
    { ...valid, anyPublicWeb: "yes" },
  ]) assert.equal(schema.agentCreateSchema.safeParse(invalid).success, false, JSON.stringify(invalid));
  // Persona is optional now (ADR-036), so an empty one is accepted on update.
  assert.equal(schema.agentUpdateSchema.safeParse({ ...valid, soulMd: "" }).success, true);
});

test("agent deletion requires the exact name and an explicit backup acknowledgement", async () => {
  const schema = unwrap(await import("../lib/agents/schema.ts"));
  assert.equal(schema.agentDeleteSchema.safeParse({ confirmation: "Daily Briefer", backupAcknowledged: true }).success, true);
  for (const invalid of [
    { confirmation: "Daily Briefer", backupAcknowledged: false },
    { confirmation: "", backupAcknowledged: true },
    { backupAcknowledged: true },
    { confirmation: "Daily Briefer", backupAcknowledged: true, ownerId: OWNER },
  ]) assert.equal(schema.agentDeleteSchema.safeParse(invalid).success, false);
});

test("blank personas receive a bounded role-based default with least-privilege boundaries", async () => {
  const schema = unwrap(await import("../lib/agents/schema.ts"));
  const soul = schema.defaultSoul("Daily Briefer", "Research analyst");
  assert.match(soul, /Daily Briefer/);
  assert.match(soul, /Research analyst/);
  assert.match(soul, /boundar/i);
  assert.match(soul, /permission/i);
  assert.ok(soul.length <= 2000);
});

test("desktop command schema accepts only scoped create/delete operations", () => {
  for (const operation of ["agent.create", "agent.delete"]) {
    assert.equal(parseCommand({ ownerId: OWNER, agentId: AGENT, requestId: randomUUID(), operation }).operation, operation);
  }
  for (const invalid of [
    { ownerId: OWNER, agentId: AGENT, requestId: randomUUID(), operation: "agent.delete", generation: randomUUID() },
    { ownerId: OWNER, agentId: AGENT, requestId: randomUUID(), operation: "agent.create", path: "/workspace/homes/forged" },
  ]) assert.throws(() => parseCommand(invalid));
});

test("desktop registry accepts deletion tombstones but rejects caller-chosen paths", async () => {
  const store = unwrap(await import("../docker/desktop/agent-store.mjs"));
  const record = { ownerId: OWNER, agentId: AGENT, uid: 20000, gid: 20000, name: "ec_20000", state: "deleting" };
  assert.equal(store.validateRegistry({ version: 1, agents: [record] }).agents[0].state, "deleting");
  assert.deepEqual(store.deletionPaths(record), {
    home: `/workspace/homes/${AGENT}`,
    downloads: `/workspace/.system/downloads/${AGENT}`,
    downloadsView: `/downloads/${AGENT}`,
    ns: `/run/eclipse-ns/${AGENT}`,
  });
  for (const invalid of [
    { ...record, agentId: "../../root" },
    { ...record, uid: 0 },
    { ...record, name: "other" },
  ]) assert.throws(() => store.deletionPaths(invalid));
  const source = await readFile("docker/desktop/agent-store.mjs", "utf8");
  const deletion = source.slice(source.indexOf("export async function deleteAgent"), source.indexOf("export async function createAgent"));
  assert.ok(deletion.indexOf("validateDeletableDirectory(targets.home") < deletion.indexOf('record.state = "deleting"'),
    "both deletion paths are validated before the tombstone");
  assert.match(source, /record\.state === "ready"/, "restart recovery skips pending and deleting tombstones");
});

test("process scanning ignores only exited PIDs and fails closed on read errors", async () => {
  const store = unwrap(await import("../docker/desktop/agent-store.mjs"));
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "eclipse-proc-scan-")));
  try {
    for (const pid of ["40", "41", "not-a-pid"]) await writeFile(path.join(root, pid), "");
    const statusPath = (pid) => `${path.sep}${pid}${path.sep}`;
    const readStatus = async (name) => {
      if (name.includes(statusPath(41))) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return "Uid:\t20000\t20000\t20000\t20000\nState:\tZ (zombie)\n";
    };
    assert.equal(await store.hasAgentProcess(20000, { procRoot: root, readStatus }), false);
    await writeFile(path.join(root, "42"), "");
    const alive = async (name) => name.includes(statusPath(42))
      ? "Uid:\t20000\t20000\t20000\t20000\nState:\tS (sleeping)\n" : readStatus(name);
    assert.equal(await store.hasAgentProcess(20000, { procRoot: root, readStatus: alive }), true);
  } finally {
    assert.equal(path.dirname(root), await realpath(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});

test("process scanning rejects permission and unexpected IO failures", async () => {
  const store = unwrap(await import("../docker/desktop/agent-store.mjs"));
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "eclipse-proc-scan-")));
  try {
    await writeFile(path.join(root, "50"), "");
    for (const code of ["EACCES", "EIO", "EPERM"]) {
      const readStatus = async () => { throw Object.assign(new Error(code), { code }); };
      await assert.rejects(store.hasAgentProcess(20000, { procRoot: root, readStatus }),
        (error) => error.code === "process_scan_failed");
    }
    const missing = async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); };
    assert.equal(await store.hasAgentProcess(20000, { procRoot: root, readStatus: missing }), false);
    const exited = async () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); };
    assert.equal(await store.hasAgentProcess(20000, { procRoot: root, readStatus: exited }), false);
    const unparseable = async () => "State:\tS (sleeping)\n";
    await assert.rejects(store.hasAgentProcess(20000, { procRoot: root, readStatus: unparseable }),
      (error) => error.code === "process_scan_failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registry writes survive stale temp files and clean failed attempts", async () => {
  const store = unwrap(await import("../docker/desktop/agent-store.mjs"));
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "eclipse-registry-write-")));
  const target = path.join(root, "agents.json");
  const value = { version: 1, agents: [{ ownerId: OWNER, agentId: AGENT, uid: 20000, gid: 20000, name: "ec_20000", state: "ready" }] };
  try {
    await assert.rejects(store.writeRegistryFile(value, path.join(root, "other.json")),
      (error) => error.code === "invalid_registry_path");
    await writeFile(`${target}.new`, "stale");
    await mkdir(target);
    await writeFile(path.join(target, "keep"), "preserved");
    await assert.rejects(store.writeRegistryFile(value, target));
    assert.equal(await readFile(`${target}.new`, "utf8"), "stale", "unknown stale file is untouched");
    assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".tmp")), []);
    assert.equal(await readFile(path.join(target, "keep"), "utf8"), "preserved");

    await rm(target, { recursive: true, force: true });
    await store.writeRegistryFile(value, target);
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), value);
    assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function flattenSql(value) {
  if (value === null || value === undefined) return [];
  if (typeof value !== "object") return [String(value)];
  if ("queryChunks" in value) return value.queryChunks.flatMap(flattenSql);
  if ("value" in value) return [String(value.value)];
  if ("name" in value && "table" in value) return [String(value.name)];
  return [];
}

function agentDatabase(rows = {}) {
  const calls = [];
  const result = (kind, table, values, condition, extra) => {
    calls.push({ kind, table, values, sql: flattenSql(condition).join(" "), extra });
    if (kind === "select") {
      if (extra?.single) return rows.agent ? [rows.agent] : [];
      return rows.policies ?? [];
    }
    return values?.returning ? [{ agentId: AGENT }] : undefined;
  };
  const query = (kind, table) => kind === "insert"
    ? { values: (values) => {
      result(kind, table, values);
      return { onConflictDoNothing() { return this; }, returning: async () => [{ agentId: values.id ?? AGENT }] };
    } }
    : kind === "update"
      ? { set: (values) => ({ where: (condition) => ({ returning: async () => { result(kind, table, values, condition); return [{ agentId: AGENT }]; } }) }) }
      : kind === "delete"
        ? { where: (condition) => ({ returning: async () => { result(kind, table, undefined, condition); return [{ agentId: AGENT }]; } }) }
        : {
          from: () => ({
            where: (condition) => ({
              limit: () => ({ orderBy: () => ({}) }),
              orderBy: async () => result(kind, table, undefined, condition),
            }),
          }),
        };
  const database = {
    select: (fields) => {
      calls.push({ kind: "selectFields", fields: Object.keys(fields) });
      return {
        from: (table) => ({
          where: (condition) => ({
            limit: async () => { calls.push({ kind: "select", table, sql: flattenSql(condition).join(" "), extra: { single: true } }); return getTableName(table) === "agent_policies" ? rows.policies ?? [] : rows.agent ? [rows.agent] : []; },
            orderBy: async () => { calls.push({ kind: "select", table, sql: flattenSql(condition).join(" "), extra: { single: false } }); return rows.agents ?? []; },
          }),
        }),
      };
    },
    insert: (table) => query("insert", table),
    update: (table) => query("update", table),
    delete: (table) => query("delete", table),
    transaction: async (callback) => callback(database),
  };
  return { database, calls };
}

test("agent records are inserted as paused with owner-scoped policies", async () => {
  const data = unwrap(await import("../lib/agents/data.ts"));
  const schema = unwrap(await import("../lib/agents/schema.ts"));
  const input = schema.agentCreateSchema.parse({
    name: "Researcher", role: "Research analyst", soulMd: "Boundaries: ask first.",
    dailyBudgetUsd: "5.00", monthlyBudgetUsd: "50.00",
    tools: ["web.fetch"], domains: ["example.com"], actions: ["read_page"], memoryScopes: ["agent"],
  });
  const { database, calls } = agentDatabase();
  const created = await data.createAgentRecord(database, OWNER, input, AGENT);
  assert.equal(created.agentId, AGENT);
  const inserts = calls.filter((call) => call.kind === "insert");
  assert.equal(inserts.length, 2);
  assert.equal(inserts[0].values.ownerId, OWNER);
  assert.equal(inserts[0].values.status, "paused");
  assert.equal(inserts[0].values.soulMd, "Boundaries: ask first.");
  assert.equal(inserts[0].values.dailyBudgetCents, 500);
  assert.equal(inserts[1].values.ownerId, OWNER);
  assert.equal(inserts[1].values.agentId, AGENT);
  assert.deepEqual(inserts[1].values.domains, ["example.com"]);
});

test("missing policy rows fail settings closed but still allow owner-scoped deletion discovery", async () => {
  const data = unwrap(await import("../lib/agents/data.ts"));
  const { database } = agentDatabase({
    agent: { id: AGENT, ownerId: OWNER, name: "Orphan", role: "Briefer", soulMd: "x", status: "paused", dailyBudgetCents: 1, monthlyBudgetCents: 1 },
    policies: [],
  });
  assert.equal(await data.getAgentRecord(database, OWNER, AGENT), undefined);
  const identity = await data.getAgentIdentity(database, OWNER, AGENT);
  assert.equal(identity?.id, AGENT);
  assert.equal(identity?.name, "Orphan");
});

function lifecycleDatabase({ statusWrites = true, deleteWrites = true } = {}) {
  const events = [];
  const state = { agent: { id: AGENT, ownerId: OWNER, name: "Concurrent", status: "paused" } };
  const select = () => ({
    from: () => ({
      where: () => ({
        limit: () => ({
          for: async (mode) => {
            assert.equal(mode, "update");
            events.push("lock");
            return state.agent ? [{ ...state.agent }] : [];
          },
        }),
      }),
    }),
  });
  const update = () => ({
    set: (values) => ({
      where: () => ({
        returning: async () => {
          events.push("status");
          if (!state.agent || statusWrites === false) return [];
          state.agent = { ...state.agent, ...values };
          return [{ agentId: AGENT }];
        },
      }),
    }),
  });
  const remove = () => ({
    where: () => ({
      returning: async () => {
        events.push("delete-row");
        if (!state.agent || deleteWrites === false) return [];
        state.agent = undefined;
        return [{ agentId: AGENT }];
      },
    }),
  });
  let tail = Promise.resolve();
  const database = {
    select,
    update,
    delete: remove,
    execute: async (query) => { events.push(["lock-timeout", String(query)]); },
    transaction: async (callback) => {
      const previous = tail;
      let release;
      tail = new Promise((resolve) => { release = resolve; });
      await previous;
      try {
        return await callback(database);
      } finally {
        release();
      }
    },
  };
  return { database, events, state };
}

const budgetOk = async () => ({ state: "ok" });

function lifecycleDesktop(events) {
  return {
    desktopCreateAgent: async () => { events.push("create-identity"); },
    desktopDeleteAgent: async () => { events.push("delete-desktop"); },
    desktopSession: async (_agentId, _ownerId, operation) => {
      if (operation === "session.start" || operation === "sandbox.start") {
        events.push("start-begin");
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push("start-end");
        return { state: "running", generation: randomUUID() };
      }
      events.push("stop");
      return { state: "stopped" };
    },
  };
}

test("resume and delete serialize the complete owner lifecycle", async () => {
  const service = unwrap(await import("../lib/agents/service.ts"));
  const { database, events, state } = lifecycleDatabase();
  const desktop = lifecycleDesktop(events);
  const resumed = service.resumeAgentForOwner(database, OWNER, AGENT, desktop, budgetOk);
  const deleted = service.deleteAgentForOwner(database, OWNER, AGENT, "Concurrent", desktop);
  await Promise.all([resumed, deleted]);
  assert.equal(events[0][0], "lock-timeout", "the bounded row-lock wait is set before locking");
  assert.ok(events.indexOf("start-end") < events.indexOf("delete-desktop"), "delete waits for resume");
  assert.ok(events.indexOf("status") < events.indexOf("delete-desktop"), "resume commits status before delete");
  assert.equal(state.agent, undefined, "winning delete removes the agent");
});

test("delete that wins prevents a waiting resume from recreating the desktop", async () => {
  const service = unwrap(await import("../lib/agents/service.ts"));
  const { database, events, state } = lifecycleDatabase();
  const desktop = lifecycleDesktop(events);
  const deleted = service.deleteAgentForOwner(database, OWNER, AGENT, "Concurrent", desktop);
  const resumed = service.resumeAgentForOwner(database, OWNER, AGENT, desktop, budgetOk).catch((error) => error);
  await Promise.all([deleted, resumed]);
  assert.equal((await resumed).code, "agent_not_found");
  assert.ok(!events.includes("create-identity") && !events.includes("start-begin"), "resume never reaches the desktop");
  assert.equal(state.agent, undefined);
});

test("lifecycle never reports success when its final database write is lost", async () => {
  const service = unwrap(await import("../lib/agents/service.ts"));
  const paused = lifecycleDatabase({ statusWrites: false });
  const desktop = lifecycleDesktop(paused.events);
  const pauseError = await service.pauseAgentForOwner(paused.database, OWNER, AGENT, desktop).catch((error) => error);
  assert.equal(pauseError.code, "agent_not_found");
  assert.ok(paused.events.includes("stop"), "pause reached the final write");
  const resumeError = await service.resumeAgentForOwner(paused.database, OWNER, AGENT, desktop, budgetOk).catch((error) => error);
  assert.equal(resumeError.code, "agent_not_found");
  assert.ok(paused.events.includes("start-end"), "resume reached the final write");
  const exhausted = lifecycleDatabase();
  const blocked = await service.resumeAgentForOwner(exhausted.database, OWNER, AGENT, lifecycleDesktop(exhausted.events),
    async () => ({ state: "paused" })).catch((error) => error);
  assert.equal(blocked.code, "budget_exhausted");
  assert.ok(!exhausted.events.includes("start-begin"), "an exhausted agent never restarts its desktop");
  const undeleted = lifecycleDatabase({ deleteWrites: false });
  const deleteError = await service.deleteAgentForOwner(undeleted.database, OWNER, AGENT, "Concurrent", lifecycleDesktop(undeleted.events))
    .catch((error) => error);
  assert.equal(deleteError.code, "agent_not_found");
  assert.ok(undeleted.events.includes("delete-desktop"), "delete reached the final row removal");
});

test("agent list/read/update/status/delete always scope by owner", async () => {
  const data = unwrap(await import("../lib/agents/data.ts"));
  const schema = unwrap(await import("../lib/agents/schema.ts"));
  const input = schema.agentUpdateSchema.parse({
    name: "Updated", role: "Briefer", soulMd: "Updated boundaries.",
    dailyBudgetUsd: "1.00", monthlyBudgetUsd: "10.00",
    tools: [], domains: [], actions: [], memoryScopes: [],
  });
  const { database, calls } = agentDatabase({
    agent: { id: AGENT, ownerId: OWNER, name: "Current", role: "Briefer", soulMd: "x", status: "paused", dailyBudgetCents: 100, monthlyBudgetCents: 1000 },
    agents: [{ id: AGENT, name: "Current", role: "Briefer", status: "paused" }],
    policies: [{ tools: [], domains: [], actions: [], memoryScopes: [] }],
  });
  await data.listAgentRecords(database, OWNER);
  await data.getAgentRecord(database, OWNER, AGENT);
  await data.updateAgentRecord(database, OWNER, AGENT, input);
  await data.setAgentStatus(database, OWNER, AGENT, "active");
  await data.deleteAgentRecord(database, OWNER, AGENT);
  const scoped = calls.filter((call) => ["select", "update", "delete"].includes(call.kind));
  assert.ok(scoped.length >= 5);
  for (const call of scoped) assert.match(call.sql, /owner_id/, `${call.kind} is owner scoped`);
  assert.ok(scoped.every((call) => call.kind === "select" ? true : call.sql.includes(OWNER)));
  const updates = calls.filter((call) => call.kind === "update");
  assert.ok(updates.some((call) => call.values.name === "Updated"));
  assert.ok(updates.some((call) => call.values.status === "active"));
});
