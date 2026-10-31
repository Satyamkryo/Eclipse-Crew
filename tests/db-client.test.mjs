import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { Readable } from "node:stream";
import { readPassword, resetOwnerPassword } from "../scripts/reset-password.mjs";

test("failed initialization can recover, concurrent calls share an attempt, and privileged roles stay denied", async () => {
  const originalQuery = pg.Pool.prototype.query;
  const originalEnd = pg.Pool.prototype.end;
  const originalUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://eclipse_app:SYNTHETIC_CANARY@localhost/eclipse";
  let attempts = 0;
  let closed = 0;
  let rejectConnection;
  pg.Pool.prototype.query = async function () {
    attempts++;
    if (attempts === 1) return new Promise((_, reject) => { rejectConnection = reject; });
    return { rows: [{ current_user: "eclipse_app", session_user: "eclipse_app", rolsuper: attempts === 2 }] };
  };
  pg.Pool.prototype.end = async function () { closed++; };
  try {
    const imported = await import("../db/client.ts");
    const getDatabase = imported.getDatabase ?? imported.default.getDatabase;
    const first = getDatabase();
    const concurrent = getDatabase();
    const settled = Promise.allSettled([first, concurrent]);
    assert.equal(first, concurrent);
    await new Promise(setImmediate);
    assert.equal(attempts, 1);
    rejectConnection(new Error("temporary SYNTHETIC_CANARY failure"));
    const rejected = await settled;
    for (const result of rejected) {
      assert.equal(result.status, "rejected");
      assert.doesNotMatch(result.reason.message, /SYNTHETIC_CANARY/);
    }
    assert.equal(closed, 1);
    await assert.rejects(getDatabase(), /role verification failed/);
    assert.equal(closed, 2);
    const recovered = getDatabase();
    assert.equal(getDatabase(), recovered);
    assert.ok(await recovered);
    assert.equal(attempts, 3);
    assert.equal(getDatabase(), recovered);
  } finally {
    pg.Pool.prototype.query = originalQuery;
    pg.Pool.prototype.end = originalEnd;
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  }
});

test("reset imports are inert and password input is bounded private stdin", async () => {
  assert.equal(await readPassword(Readable.from(["synthetic secret\r\n"])), "synthetic secret");
  for (const invalid of ["short", "valid password\nsecond line", "x".repeat(129), "x".repeat(4097), "valid\0password"]) {
    await assert.rejects(readPassword(Readable.from([invalid])));
  }
  const tty = Readable.from(["synthetic secret"]);
  tty.isTTY = true;
  await assert.rejects(readPassword(tty), /private stdin/);
});

test("reset refuses zero/multiple/mismatched owners before changing data", async () => {
  for (const rows of [[], [{ id: "a", ownerId: "a" }, { id: "b", ownerId: "b" }], [{ id: "a", ownerId: "b" }]]) {
    let mutations = 0;
    let locks = 0;
    const transaction = {
      execute: async () => { locks++; },
      select: () => ({ from: () => ({ limit: () => ({ for: async () => rows }) }) }),
      update: () => { mutations++; }, delete: () => { mutations++; },
    };
    const db = { transaction: async (callback) => callback(transaction) };
    const schema = { owner: { id: "id", ownerId: "ownerId" } };
    await assert.rejects(resetOwnerPassword(db, schema, async () => "synthetic hash", "synthetic password"), /single valid owner/);
    assert.equal(locks, 1);
    assert.equal(mutations, 0);
  }
});
