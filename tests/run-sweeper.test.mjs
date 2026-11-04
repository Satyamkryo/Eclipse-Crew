import assert from "node:assert/strict";
import test from "node:test";
import { startHeartbeat } from "../lib/runs/heartbeat.ts";
import { sealExisting } from "../lib/receipts/store.ts";
import { loadReceiptSigner } from "../lib/receipts/signer.ts";

const signer = loadReceiptSigner("ab".repeat(32));
const OWNER = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";

async function waitForCount(readCount, expected, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (readCount() < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(readCount() >= expected, `expected ${expected} callbacks within ${timeoutMs} ms; got ${readCount()}`);
}

test("heartbeat updates the run, stops on a missing row, and reports a database cancel", async () => {
  let beats = 0; let sealed = 0; let cancelled = 0;
  const database = { update() { const q = { set() { return q; }, where() { return q; }, async returning() {
    beats += 1; return beats === 3 ? [] : [{ cancel: beats === 2 ? new Date() : null }];
  } }; return q; } };
  const stop = startHeartbeat(database, OWNER, RUN, { onCancel: () => { cancelled += 1; }, onSealed: () => { sealed += 1; }, intervalMs: 5 });
  await waitForCount(() => beats, 3);
  stop();
  assert.ok(beats >= 3); assert.equal(cancelled, 1); assert.equal(sealed, 1);
});

test("a heartbeat database error never stops a run", async () => {
  let sealed = 0; let calls = 0;
  const database = { update() { const q = { set() { return q; }, where() { return q; }, async returning() { calls += 1; throw Error("db down"); } }; return q; } };
  const stop = startHeartbeat(database, OWNER, RUN, { onCancel: () => {}, onSealed: () => { sealed += 1; }, intervalMs: 5 });
  await waitForCount(() => calls, 2); stop();
  assert.ok(calls >= 2); assert.equal(sealed, 0);
});

test("sealExisting derives count, head and summed usage and signs once", async () => {
  let update;
  const steps = [
    { receiptJson: JSON.stringify({ usage: { input: 10, output: 2, cached: 3, reasoning: 1 } }), receiptHash: "a".repeat(64) },
    { receiptJson: JSON.stringify({ usage: { input: 5, output: 1, cached: 0, reasoning: 0 } }), receiptHash: "b".repeat(64) },
  ];
  let selects = 0;
  const database = {
    select() { const value = selects++ === 0 ? [{ headerHash: "c".repeat(64), signature: null }] : steps;
      const q = { from() { return q; }, where() { return q; }, orderBy() { return q; }, limit() { return Promise.resolve(value); },
        then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } }; return q; },
    update() { const q = { set(value) { update = value; return q; }, where() { return q; },
      async returning() { return [{ id: RUN }]; } }; return q; },
  };
  const result = await sealExisting({ database, ownerId: OWNER, runId: RUN, signer, status: "interrupted", now: new Date("2026-11-03T00:00:00.000Z") });
  assert.deepEqual(result, { sealed: true, stepCount: 2 });
  assert.equal(update.status, "interrupted");
  assert.equal(update.stepCount, 2);
  assert.equal(update.headHash, "b".repeat(64));
  assert.deepEqual(update.usage, { input: 15, output: 3, cached: 3, reasoning: 1 });
  assert.match(update.signature, /^[A-Za-z0-9_-]+$/);
  const already = await sealExisting({ database: { select() { const q = { from() { return q; }, where() { return q; }, limit() { return Promise.resolve([{ headerHash: "c".repeat(64), signature: "sealed" }]); } }; return q; },
    update() { throw Error("must not update"); } }, ownerId: OWNER, runId: RUN, signer, status: "interrupted" });
  assert.deepEqual(already, { sealed: false, stepCount: 0 });
});
