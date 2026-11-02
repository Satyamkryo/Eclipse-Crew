// Signed append-only audit log: canonical entries, hash chain and offline verification (TASK-052).
//
// Plain JavaScript with node:crypto only, so the offline CLI (scripts/eclipse-crew.mjs) can run it with bare `node`.
// Nothing here reads the environment, a database or the network. One chain per owner: the first entry links to a
// genesis hash derived from the owner id, so entries from another owner's chain do not verify in this one.
import { createPublicKey, sign, verify } from "node:crypto";

import { canonicalJson, isKeyId, isUuid, keyIdOf, sha256Hex } from "../receipts/chain.mjs";

export const AUDIT_FORMAT = "eclipse-crew-audit/1";
export const AUDIT_VERSION = 1;
const ENTRY_DOMAIN = "eclipse-crew/audit-entry/v1\n";
const GENESIS_DOMAIN = "eclipse-crew/audit-genesis/v1\n";
const MAX_ENTRIES = 100_000;
const HEX64 = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CODE = /^[a-z_]{1,48}$/;
const REF = /^[A-Za-z0-9_.:-]{1,120}$/;
const HOST = /^[a-z0-9.:[\]-]{1,253}$/;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export const AUDIT_REASONS = Object.freeze([
  "bad_format", "key_id_mismatch", "pin_mismatch", "entry_hash_mismatch", "entry_mismatch",
  "seq_missing", "seq_order", "prev_hash_mismatch", "bad_signature", "seq_pin_mismatch",
]);

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nullable = (value, test) => value === null || test(value);
const uuidOrNull = (value) => nullable(value, isUuid);
const codeOrNull = (value) => nullable(value, (item) => typeof item === "string" && CODE.test(item));
const refOrNull = (value) => nullable(value, (item) => typeof item === "string" && REF.test(item));
const hostOrNull = (value) => nullable(value, (item) => typeof item === "string" && HOST.test(item));

export function genesisHash(ownerId) {
  if (!isUuid(ownerId)) throw new TypeError("Invalid owner id.");
  return sha256Hex(GENESIS_DOMAIN + ownerId);
}

export function entryFields(input) {
  if (!isRecord(input)) throw new TypeError("Invalid audit entry.");
  if (!Number.isSafeInteger(input.seq) || input.seq < 1) throw new TypeError("Invalid audit sequence.");
  if (typeof input.kind !== "string" || !CODE.test(input.kind)) throw new TypeError("Invalid audit kind.");
  if (!uuidOrNull(input.agentId) || !uuidOrNull(input.runId) || !refOrNull(input.ref) ||
      !codeOrNull(input.code) || !hostOrNull(input.host)) throw new TypeError("Invalid audit field.");
  if (typeof input.ts !== "string" || !ISO_TIME.test(input.ts)) throw new TypeError("Invalid audit time.");
  if (typeof input.prevHash !== "string" || !HEX64.test(input.prevHash)) throw new TypeError("Invalid previous hash.");
  return {
    v: AUDIT_VERSION, seq: input.seq, kind: input.kind,
    agent_id: input.agentId ?? null, run_id: input.runId ?? null, ref: input.ref ?? null,
    code: input.code ?? null, host: input.host ?? null, ts: input.ts, prev_hash: input.prevHash,
  };
}

// The stored canonical text is the entry: it is what gets re-hashed years later, exactly like a step receipt.
export function buildAuditEntry(input) {
  const text = canonicalJson(entryFields(input));
  return { text, hash: sha256Hex(text) };
}

// The signature covers the entry hash, not the text, with its own domain string so an audit signature can never be
// mistaken for a run seal or a step receipt.
export function signAuditEntry(privateKey, entryHash) {
  if (typeof entryHash !== "string" || !HEX64.test(entryHash)) throw new TypeError("Invalid entry hash.");
  return sign(null, Buffer.from(ENTRY_DOMAIN + entryHash, "utf8"), privateKey).toString("base64url");
}

export function buildAuditExport({ ownerId, keyId, publicKey, exportedAt, entries }) {
  if (!isUuid(ownerId) || !isKeyId(keyId) || typeof publicKey !== "string") throw new TypeError("Invalid audit export header.");
  return {
    format: AUDIT_FORMAT,
    owner_id: ownerId,
    key_id: keyId,
    public_key: publicKey,
    exported_at: exportedAt,
    entries: entries.map((row) => ({
      seq: row.seq, entry: row.entryText, entry_hash: row.entryHash, prev_hash: row.prevHash, signature: row.signature,
    })),
  };
}

function publicKeyObject(publicKeyB64) {
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyB64, "base64url")]), format: "der", type: "spki" });
}

function validPublicKey(value) {
  if (typeof value !== "string" || !BASE64URL.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === value;
}

const fail = (reason, seq) => ({ ok: false, reason, ...(seq === undefined ? {} : { seq }) });

// Checks an `eclipse-crew-audit/1` export. Never throws on hostile input; returns { ok, reason, seq? }.
// Truncation at the end can only be detected against an earlier export or a pinned head length (`--expect-seq`).
export function verifyAuditExport(exported, { pinnedKeyId, expectSeq } = {}) {
  try {
    if (!isRecord(exported) || exported.format !== AUDIT_FORMAT || !isUuid(exported.owner_id) ||
        !isKeyId(exported.key_id) || !validPublicKey(exported.public_key) ||
        typeof exported.exported_at !== "string" || !ISO_TIME.test(exported.exported_at) ||
        !Array.isArray(exported.entries) || exported.entries.length > MAX_ENTRIES) return fail("bad_format");
    if (pinnedKeyId !== undefined && !isKeyId(pinnedKeyId)) return fail("bad_format");
    if (expectSeq !== undefined && (!Number.isSafeInteger(expectSeq) || expectSeq < 0)) return fail("bad_format");

    if (keyIdOf(Buffer.from(exported.public_key, "base64url")) !== exported.key_id) return fail("key_id_mismatch");
    if (pinnedKeyId !== undefined && pinnedKeyId !== exported.key_id) return fail("pin_mismatch");

    const key = publicKeyObject(exported.public_key);
    const indexes = new Set(exported.entries.map((row) => (isRecord(row) ? row.seq : undefined)));
    let previous = genesisHash(exported.owner_id);
    for (let position = 0; position < exported.entries.length; position++) {
      const expected = position + 1;
      const row = exported.entries[position];
      if (!isRecord(row) || typeof row.entry !== "string" || typeof row.entry_hash !== "string" || !HEX64.test(row.entry_hash) ||
          typeof row.prev_hash !== "string" || !HEX64.test(row.prev_hash) || !Number.isSafeInteger(row.seq) ||
          typeof row.signature !== "string" || !BASE64URL.test(row.signature) ||
          Buffer.from(row.signature, "base64url").length !== 64) return fail("bad_format", expected);
      if (row.seq !== expected) return fail(row.seq < expected || indexes.has(expected) ? "seq_order" : "seq_missing", expected);
      if (row.prev_hash !== previous) return fail("prev_hash_mismatch", expected);
      if (sha256Hex(row.entry) !== row.entry_hash) return fail("entry_hash_mismatch", expected);

      let entry;
      try { entry = JSON.parse(row.entry); } catch { return fail("bad_format", expected); }
      if (!isRecord(entry) || canonicalJson(entry) !== row.entry) return fail("bad_format", expected);
      if (entry.v !== AUDIT_VERSION || entry.seq !== row.seq || entry.prev_hash !== previous ||
          typeof entry.kind !== "string" || !CODE.test(entry.kind) ||
          !uuidOrNull(entry.agent_id) || !uuidOrNull(entry.run_id) || !refOrNull(entry.ref) ||
          !codeOrNull(entry.code) || !hostOrNull(entry.host) ||
          typeof entry.ts !== "string" || !ISO_TIME.test(entry.ts)) return fail("entry_mismatch", expected);

      const message = Buffer.from(ENTRY_DOMAIN + row.entry_hash, "utf8");
      if (!verify(null, message, key, Buffer.from(row.signature, "base64url"))) return fail("bad_signature", expected);
      previous = row.entry_hash;
    }

    const headSeq = exported.entries.length;
    if (expectSeq !== undefined && expectSeq !== headSeq) return fail("seq_pin_mismatch");
    return {
      ok: true, ownerId: exported.owner_id, keyId: exported.key_id, entries: headSeq,
      headSeq, headHash: headSeq === 0 ? genesisHash(exported.owner_id) : previous, pinned: pinnedKeyId !== undefined,
    };
  } catch {
    return fail("bad_format");
  }
}
