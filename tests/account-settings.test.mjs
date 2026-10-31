import assert from "node:assert/strict";
import { test } from "node:test";

const unwrap = (module) => module.default ?? module;
const password = unwrap(await import("../lib/auth/password.ts"));

function flattenSql(value) {
  if (value === null || value === undefined) return [];
  if (typeof value !== "object") return [String(value)];
  if ("queryChunks" in value) return value.queryChunks.flatMap(flattenSql);
  if ("value" in value) return [String(value.value)];
  if ("name" in value && "table" in value) return [String(value.name)];
  return [];
}

function transactionalDatabase(ownerRow, calls) {
  const transaction = {
    execute: async (statement) => { calls.push({ kind: "execute", sql: flattenSql(statement).join(" ") }); },
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => ({ for: async () => ownerRow ? [ownerRow] : [] }) }),
      }),
    }),
    update: () => ({
      set: (values) => ({
        where: async (condition) => { calls.push({ kind: "update", values, sql: flattenSql(condition).join(" ") }); },
      }),
    }),
    delete: () => ({
      where: async (condition) => { calls.push({ kind: "delete", sql: flattenSql(condition).join(" ") }); },
    }),
  };
  return { transaction: async (callback) => callback(transaction), calls };
}

test("password change verifies the current password and revokes only other sessions in one transaction", async () => {
  const account = unwrap(await import("../lib/auth/account.ts"));
  const ownerId = "11111111-1111-4111-8111-111111111111";
  const currentSessionId = "22222222-2222-4222-8222-222222222222";
  const ownerRow = { id: ownerId, ownerId, passwordHash: await password.hashPassword("current-password") };
  const calls = [];
  const db = transactionalDatabase(ownerRow, calls);

  assert.equal(await account.changeOwnerPassword(db, ownerId, currentSessionId, "current-password", "replacement-password"), true);

  const update = calls.find((call) => call.kind === "update");
  assert.ok(update, "password hash update ran");
  assert.match(update.values.passwordHash, /^\$argon2id\$/);
  assert.equal(await password.verifyPassword(update.values.passwordHash, "replacement-password"), true);
  assert.match(update.sql, /owner_id/);
  assert.match(update.sql, new RegExp(ownerId));
  const deletion = calls.find((call) => call.kind === "delete");
  assert.ok(deletion, "other sessions were revoked");
  assert.match(deletion.sql, /owner_id/);
  assert.match(deletion.sql, new RegExp(ownerId));
  assert.match(deletion.sql, /<>\s*22222222-2222-4222-8222-222222222222|<>/);
  assert.match(deletion.sql, new RegExp(currentSessionId));
});

test("wrong current passwords leave credentials and every session unchanged", async () => {
  const account = unwrap(await import("../lib/auth/account.ts"));
  const ownerId = "11111111-1111-4111-8111-111111111111";
  const calls = [];
  const db = transactionalDatabase({ id: ownerId, ownerId, passwordHash: await password.hashPassword("current-password") }, calls);

  assert.equal(await account.changeOwnerPassword(db, ownerId, "22222222-2222-4222-8222-222222222222", "incorrect", "replacement-password"), false);
  assert.equal(await account.changeOwnerEmail(db, ownerId, "incorrect", "new-owner@example.test"), false);
  assert.deepEqual(calls.filter((call) => call.kind !== "execute"), []);
});

test("email change normalizes the login after verifying the current password", async () => {
  const account = unwrap(await import("../lib/auth/account.ts"));
  const ownerId = "11111111-1111-4111-8111-111111111111";
  const calls = [];
  const db = transactionalDatabase({ id: ownerId, ownerId, passwordHash: await password.hashPassword("current-password") }, calls);

  assert.equal(await account.changeOwnerEmail(db, ownerId, "current-password", "New.Owner@Example.Test"), true);

  const update = calls.find((call) => call.kind === "update");
  assert.deepEqual(update.values, { login: "new.owner@example.test" });
  assert.match(update.sql, new RegExp(ownerId));
  assert.equal(calls.some((call) => call.kind === "delete"), false, "email change does not revoke sessions");
});

test("revoke-others deletes only the authenticated owner's other sessions", async () => {
  const account = unwrap(await import("../lib/auth/account.ts"));
  const calls = [];
  const db = transactionOnlyDatabase(calls);

  await account.revokeOtherSessions(db, "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222");

  const deletion = calls.find((call) => call.kind === "delete");
  assert.ok(deletion);
  assert.match(deletion.sql, /11111111-1111-4111-8111-111111111111/);
  assert.match(deletion.sql, /22222222-2222-4222-8222-222222222222/);
  assert.match(deletion.sql, /<>/);
});

test("a failed password transaction propagates the error and leaves the old password usable", async () => {
  const account = unwrap(await import("../lib/auth/account.ts"));
  const ownerId = "11111111-1111-4111-8111-111111111111";
  const ownerRow = { id: ownerId, ownerId, passwordHash: await password.hashPassword("current-password") };
  const calls = [];
  const db = failingTransactionDatabase(ownerRow, calls);

  await assert.rejects(
    account.changeOwnerPassword(db, ownerId, "22222222-2222-4222-8222-222222222222", "current-password", "replacement-password"),
    /delete_denied/,
  );

  assert.equal(await password.verifyPassword(ownerRow.passwordHash, "current-password"), true);
  assert.equal(await password.verifyPassword(ownerRow.passwordHash, "replacement-password"), false);
  assert.equal(calls.filter((call) => call.kind === "rollback").length, 1);
});

function failingTransactionDatabase(ownerRow, calls) {
  const originalHash = ownerRow.passwordHash;
  const transaction = {
    execute: async () => {},
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => ({ for: async () => [ownerRow] }) }),
      }),
    }),
    update: () => ({
      set: (values) => ({
        where: async () => { ownerRow.passwordHash = values.passwordHash; calls.push({ kind: "update" }); },
      }),
    }),
    delete: () => ({
      where: async () => { calls.push({ kind: "delete" }); throw new Error("delete_denied"); },
    }),
  };
  return {
    transaction: async (callback) => {
      try { return await callback(transaction); }
      catch (error) { ownerRow.passwordHash = originalHash; calls.push({ kind: "rollback" }); throw error; }
    },
  };
}

function transactionOnlyDatabase(calls) {
  const transaction = {
    delete: () => ({
      where: async (condition) => { calls.push({ kind: "delete", sql: flattenSql(condition).join(" ") }); },
    }),
  };
  return { transaction: async (callback) => callback(transaction), calls };
}

test("account overview returns only safe live-session fields with the current session first", async () => {
  const account = unwrap(await import("../lib/auth/account.ts"));
  const ownerId = "11111111-1111-4111-8111-111111111111";
  const currentSessionId = "22222222-2222-4222-8222-222222222222";
  const older = new Date("2026-10-30T10:00:00.000Z");
  const newer = new Date("2026-10-31T10:00:00.000Z");
  const expiry = new Date("2026-11-30T10:00:00.000Z");
  const selected = {};
  const db = {
    select: (fields) => {
      const keys = Object.keys(fields).sort();
      if (keys.join(",") === "login,timezone") return ownerSelect([{ login: "owner@example.test", timezone: "Asia/Kolkata" }]);
      selected.sessions = keys;
      return sessionSelect([
        { id: "33333333-3333-4333-8333-333333333333", createdAt: newer, expiresAt: expiry },
        { id: currentSessionId, createdAt: older, expiresAt: expiry },
      ], selected);
    },
  };

  const overview = await account.getAccountOverview(db, ownerId, currentSessionId);

  assert.equal(overview.login, "owner@example.test");
  assert.equal(overview.timezone, "Asia/Kolkata");
  assert.deepEqual(selected.sessions, ["createdAt", "expiresAt", "id"]);
  assert.match(selected.sessionsWhere, /owner_id/);
  assert.match(selected.sessionsWhere, new RegExp(ownerId));
  assert.match(selected.sessionsWhere, /expires_at/);
  assert.match(selected.sessionsWhere, />/);
  assert.deepEqual(overview.sessions.map((session) => [session.id, session.current]), [
    [currentSessionId, true],
    ["33333333-3333-4333-8333-333333333333", false],
  ]);
  assert.equal("tokenHash" in overview.sessions[0], false);
  assert.equal("csrfToken" in overview.sessions[0], false);
});

function ownerSelect(rows) {
  return {
    from: () => ({
      where: () => ({ limit: async () => rows }),
    }),
  };
}

function sessionSelect(rows, selected) {
  return {
    from: () => ({
      where: (condition) => {
        selected.sessionsWhere = flattenSql(condition).join(" ");
        return { orderBy: async () => rows };
      },
    }),
  };
}
