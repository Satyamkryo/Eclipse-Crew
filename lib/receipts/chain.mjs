// Proof-receipt chain: canonical JSON, hashing, Ed25519 sealing and offline verification (TASK-029).
//
// Plain JavaScript with node:crypto only, so the offline CLI (scripts/eclipse-crew.mjs) can run it with bare `node`.
// Nothing here reads the environment, a database or the network.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export const RECEIPT_VERSION = 1;
export const EXPORT_FORMAT = "eclipse-crew-run/1";
const SEAL_DOMAIN = "eclipse-crew/run-seal/v1\n";
const MAX_DEPTH = 16;
const MAX_STEPS = 100_000;
const HEX64 = /^[0-9a-f]{64}$/;
const KEY_ID = /^sha256:[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export const REASONS = Object.freeze([
  "bad_format", "header_hash_mismatch", "header_mismatch", "receipt_hash_mismatch", "receipt_mismatch",
  "prev_hash_mismatch", "step_missing", "step_order", "step_count_mismatch", "head_hash_mismatch",
  "bad_signature", "unsealed", "key_id_mismatch", "pin_mismatch",
]);

export function isKeyId(value) { return typeof value === "string" && KEY_ID.test(value); }
export function isUuid(value) { return typeof value === "string" && UUID.test(value); }

// Sorted keys, no whitespace, integers only. The same value always gives the same bytes, in any language that
// follows these rules, so a stored text can be re-hashed years later.
export function canonicalJson(value, depth = 0) {
  if (depth > MAX_DEPTH) throw new TypeError("Value is nested too deeply.");
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean": return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) throw new TypeError("Only safe integers are allowed.");
      return String(value);
    case "string":
      if (!value.isWellFormed()) throw new TypeError("Strings must be well-formed Unicode.");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError("Only plain objects are allowed.");
      const keys = Object.keys(value).sort();
      return `{${keys.map((key) => {
        if (value[key] === undefined) throw new TypeError("undefined is not allowed.");
        return `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`;
      }).join(",")}}`;
    }
    default: throw new TypeError("Unsupported value.");
  }
}

export function sha256Hex(data) { return createHash("sha256").update(data).digest("hex"); }

// Untrusted text (page control names) that enters a receipt: no control characters, bounded length.
export function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/ {2,}/g, " ").trim().toWellFormed().slice(0, max);
}

// ---- keys ------------------------------------------------------------------------------------------------------

export function keyIdOf(publicKeyRaw) { return `sha256:${sha256Hex(publicKeyRaw)}`; }

// The 64-hex install secret is an Ed25519 seed. Returns the private key object, the raw 32-byte public key (base64url)
// and its fingerprint. The seed itself never leaves this function.
export function deriveKeys(seedHex) {
  if (typeof seedHex !== "string" || !HEX64.test(seedHex)) throw new TypeError("Receipt signing seed must be 64 lowercase hex characters.");
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const raw = spki.subarray(spki.length - 32);
  return { privateKey, publicKey: raw.toString("base64url"), keyId: keyIdOf(raw) };
}

function publicKeyObject(publicKeyB64) {
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyB64, "base64url")]), format: "der", type: "spki" });
}

function validPublicKey(value) {
  if (typeof value !== "string" || !BASE64URL.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === value;
}

// ---- building --------------------------------------------------------------------------------------------------

export function buildHeader({ runId, agentId, agentName, task, startedAt, keyId, branchOf, branchAt }) {
  if (branchOf !== undefined && (!UUID.test(branchOf) || !Number.isSafeInteger(branchAt) || branchAt < 0)) {
    throw new TypeError("Invalid branch header.");
  }
  const text = canonicalJson({
    v: RECEIPT_VERSION, run_id: runId, agent_id: agentId, agent_name: cleanText(agentName, 200),
    task: cleanText(task, 2000), started_at: startedAt, key_id: keyId,
    // TASK-043. Written only for a branch, so every earlier header and hash stays byte-identical.
    ...(branchOf === undefined ? {} : { branch_of: branchOf, branch_at: branchAt }),
  });
  return { text, hash: sha256Hex(text) };
}

// `fields` holds everything except `v` and `prev_hash`. The hash is over the stored text, which excludes itself.
export function buildReceipt(fields, prevHash) {
  const text = canonicalJson({ ...fields, v: RECEIPT_VERSION, prev_hash: prevHash });
  return { text, hash: sha256Hex(text) };
}

function sealPayload({ runId, headerHash, stepCount, headHash, status, endedAt, usage }) {
  return canonicalJson({
    run_id: runId, header_hash: headerHash, step_count: stepCount, head_hash: headHash, status, ended_at: endedAt,
    usage: { input: usage.input, output: usage.output, cached: usage.cached, reasoning: usage.reasoning },
  });
}

export function sealRun(privateKey, seal) {
  const message = Buffer.from(SEAL_DOMAIN + sealPayload(seal), "utf8");
  return sign(null, message, privateKey).toString("base64url");
}

export function buildRunExport(run, steps) {
  return {
    format: EXPORT_FORMAT, run_id: run.runId, header: run.headerText, header_hash: run.headerHash,
    key_id: run.keyId, public_key: run.publicKey,
    steps: steps.map((step) => ({ idx: step.idx, receipt: step.receiptText, receipt_hash: step.receiptHash, prev_hash: step.prevHash })),
    seal: run.seal ? {
      status: run.seal.status, ended_at: run.seal.endedAt, step_count: run.seal.stepCount, head_hash: run.seal.headHash,
      usage: run.seal.usage, signature: run.seal.signature,
    } : null,
  };
}

// ---- verifying -------------------------------------------------------------------------------------------------

const fail = (reason, step) => ({ ok: false, reason, ...(step === undefined ? {} : { step }) });
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

function parseCanonical(text) {
  if (typeof text !== "string") return null;
  try {
    const value = JSON.parse(text);
    return isRecord(value) && canonicalJson(value) === text ? value : null;
  } catch { return null; }
}

function validSeal(seal) {
  return isRecord(seal) && typeof seal.status === "string" && /^[a-z_]{1,32}$/.test(seal.status) &&
    typeof seal.ended_at === "string" && ISO_TIME.test(seal.ended_at) && isCount(seal.step_count) &&
    typeof seal.head_hash === "string" && HEX64.test(seal.head_hash) && isRecord(seal.usage) &&
    ["input", "output", "cached", "reasoning"].every((key) => isCount(seal.usage[key])) &&
    typeof seal.signature === "string" && BASE64URL.test(seal.signature) && Buffer.from(seal.signature, "base64url").length === 64;
}

// Checks an `eclipse-crew-run/1` export. Never throws on hostile input; returns { ok, reason, step? }.
export function verifyRunExport(exported, { pinnedKeyId } = {}) {
  try {
    if (!isRecord(exported) || exported.format !== EXPORT_FORMAT || !isUuid(exported.run_id) ||
        typeof exported.header !== "string" || typeof exported.header_hash !== "string" || !HEX64.test(exported.header_hash) ||
        !isKeyId(exported.key_id) || !validPublicKey(exported.public_key) ||
        !Array.isArray(exported.steps) || exported.steps.length > MAX_STEPS ||
        (exported.seal !== null && !validSeal(exported.seal))) return fail("bad_format");
    if (pinnedKeyId !== undefined && !isKeyId(pinnedKeyId)) return fail("bad_format");

    if (keyIdOf(Buffer.from(exported.public_key, "base64url")) !== exported.key_id) return fail("key_id_mismatch");
    if (pinnedKeyId !== undefined && pinnedKeyId !== exported.key_id) return fail("pin_mismatch");

    if (sha256Hex(exported.header) !== exported.header_hash) return fail("header_hash_mismatch");
    const header = parseCanonical(exported.header);
    if (!header || header.v !== RECEIPT_VERSION) return fail("bad_format");
    if (header.run_id !== exported.run_id || header.key_id !== exported.key_id) return fail("header_mismatch");

    const indexes = new Set(exported.steps.map((step) => (isRecord(step) ? step.idx : undefined)));
    let previous = exported.header_hash;
    for (let position = 0; position < exported.steps.length; position++) {
      const expected = position + 1;
      const step = exported.steps[position];
      if (!isRecord(step) || typeof step.receipt !== "string" || typeof step.receipt_hash !== "string" ||
          !HEX64.test(step.receipt_hash) || typeof step.prev_hash !== "string" || !HEX64.test(step.prev_hash) ||
          !Number.isSafeInteger(step.idx)) return fail("bad_format", expected);
      if (step.idx !== expected) return fail(step.idx < expected || indexes.has(expected) ? "step_order" : "step_missing", expected);
      if (sha256Hex(step.receipt) !== step.receipt_hash) return fail("receipt_hash_mismatch", expected);
      const receipt = parseCanonical(step.receipt);
      if (!receipt || receipt.v !== RECEIPT_VERSION) return fail("bad_format", expected);
      if (receipt.run_id !== exported.run_id || receipt.idx !== expected) return fail("receipt_mismatch", expected);
      if (step.prev_hash !== previous || receipt.prev_hash !== previous) return fail("prev_hash_mismatch", expected);
      previous = step.receipt_hash;
    }

    if (exported.seal === null) return fail("unsealed");
    const seal = exported.seal;
    if (seal.step_count !== exported.steps.length) return fail("step_count_mismatch");
    if (seal.head_hash !== previous) return fail("head_hash_mismatch");
    const message = Buffer.from(SEAL_DOMAIN + sealPayload({
      runId: exported.run_id, headerHash: exported.header_hash, stepCount: seal.step_count, headHash: seal.head_hash,
      status: seal.status, endedAt: seal.ended_at, usage: seal.usage,
    }), "utf8");
    if (!verify(null, message, publicKeyObject(exported.public_key), Buffer.from(seal.signature, "base64url"))) return fail("bad_signature");

    return { ok: true, runId: exported.run_id, keyId: exported.key_id, steps: exported.steps.length, pinned: pinnedKeyId !== undefined };
  } catch {
    return fail("bad_format");
  }
}
