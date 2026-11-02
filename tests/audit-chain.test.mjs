import assert from "node:assert/strict";
import test from "node:test";

import { deriveKeys } from "../lib/receipts/chain.mjs";
import {
  AUDIT_FORMAT, buildAuditEntry, buildAuditExport, genesisHash, signAuditEntry, verifyAuditExport,
} from "../lib/security/audit-chain.mjs";

const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const OTHER_SEED = "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb";
const OWNER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

function rowsFor({ seed = SEED, ownerId = OWNER, count = 3 } = {}) {
  const keys = deriveKeys(seed);
  const rows = [];
  let head = genesisHash(ownerId);
  for (let seq = 1; seq <= count; seq++) {
    const entry = buildAuditEntry({
      seq, kind: seq === 2 ? "agent_paused" : "login", agentId: seq === 1 ? null : AGENT, runId: null,
      ref: null, code: seq === 1 ? null : "settings_changed", host: null,
      ts: `2026-11-02T12:00:0${seq}.000Z`, prevHash: head,
    });
    rows.push({ seq, entryText: entry.text, entryHash: entry.hash, prevHash: head, signature: signAuditEntry(keys.privateKey, entry.hash) });
    head = entry.hash;
  }
  return { keys, rows, head };
}

function exportFor(options = {}) {
  const { keys, rows } = rowsFor(options);
  return buildAuditExport({
    ownerId: options.ownerId ?? OWNER, keyId: keys.keyId, publicKey: keys.publicKey,
    exportedAt: "2026-11-02T12:05:00.000Z", entries: rows,
  });
}

test("an untouched export verifies: contiguous entries, links, signature and key id", () => {
  const exported = exportFor();
  const result = verifyAuditExport(exported);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.ownerId, OWNER);
  assert.equal(result.entries, 3);
  assert.equal(result.headSeq, 3);
  assert.equal(result.headHash, exported.entries[2].entry_hash);
  assert.equal(result.pinned, false);

  const empty = buildAuditExport({
    ownerId: OWNER, keyId: deriveKeys(SEED).keyId, publicKey: deriveKeys(SEED).publicKey,
    exportedAt: "2026-11-02T12:05:00.000Z", entries: [],
  });
  const emptyResult = verifyAuditExport(empty);
  assert.equal(emptyResult.ok, true);
  assert.equal(emptyResult.headHash, genesisHash(OWNER));
});

test("a pinned key must match; another key is rejected", () => {
  const exported = exportFor();
  assert.equal(verifyAuditExport(exported, { pinnedKeyId: exported.key_id }).ok, true);
  const wrong = verifyAuditExport(exported, { pinnedKeyId: deriveKeys(OTHER_SEED).keyId });
  assert.deepEqual(wrong, { ok: false, reason: "pin_mismatch" });
});

test("--expect-seq detects truncation at the end", () => {
  const exported = exportFor();
  exported.entries.pop();
  assert.equal(verifyAuditExport(exported).ok, true, "a shortened chain is still internally valid");
  assert.deepEqual(verifyAuditExport(exported, { expectSeq: 3 }), { ok: false, reason: "seq_pin_mismatch" });
  assert.equal(verifyAuditExport(exportFor(), { expectSeq: 3 }).ok, true);
});

test("every tamper case fails with the matching reason", () => {
  const cases = {
    altered_entry: [(e) => { e.entries[1].entry = e.entries[1].entry.replace("agent_paused", "agent_deleted"); }, "entry_hash_mismatch", 2],
    removed_middle: [(e) => { e.entries.splice(1, 1); }, "seq_missing", 2],
    reordered: [(e) => { [e.entries[1], e.entries[2]] = [e.entries[2], e.entries[1]]; }, "seq_order", 2],
    relinked: [(e) => { e.entries[1].prev_hash = genesisHash(OWNER); }, "prev_hash_mismatch", 2],
    other_owner: [(e) => { e.owner_id = "33333333-3333-4333-8333-333333333333"; }, "prev_hash_mismatch", 1],
    signature: [(e) => { e.entries[2].signature = Buffer.alloc(64, 7).toString("base64url"); }, "bad_signature", 3],
    key_id: [(e) => { e.key_id = deriveKeys(OTHER_SEED).keyId; }, "key_id_mismatch", null],
    format: [(e) => { e.format = "something-else"; }, "bad_format", null],
    entry_seq: [(e) => {
      e.entries[2].entry = e.entries[2].entry.replace('"seq":3', '"seq":9');
      e.entries[2].entry_hash = "0".repeat(64);
    }, "entry_hash_mismatch", 3],
  };
  for (const [name, [tamper, reason, seq]] of Object.entries(cases)) {
    const exported = JSON.parse(JSON.stringify(exportFor()));
    tamper(exported);
    const result = verifyAuditExport(exported);
    assert.equal(result.ok, false, name);
    assert.equal(result.reason, reason, name);
    assert.equal(result.seq ?? null, seq, name);
  }
});

test("hostile input never throws", () => {
  for (const value of [null, 1, "x", [], { format: AUDIT_FORMAT }, { ...exportFor(), entries: "no" }]) {
    const result = verifyAuditExport(value);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "bad_format");
  }
});
