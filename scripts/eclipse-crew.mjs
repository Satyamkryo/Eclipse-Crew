#!/usr/bin/env node
/**
 * eclipse-crew: offline tools for an Eclipse Crew install (TASK-030).
 *
 *   eclipse-crew verify <run.json|-> [--key-id sha256:<hex>] [--json]
 *   eclipse-crew verify-audit <audit.json|-> [--key-id sha256:<hex>] [--expect-seq <n>] [--json]
 *   eclipse-crew key-id
 *
 * Needs only Node.js: no database, no network, no .env, no Docker, no dependency. It finds its code from its own real
 * path, so a symlink or launcher in a PATH folder works from any directory.
 *
 * `verify` never prints text taken from the file other than a validated run id and key id, so a crafted file cannot send
 * terminal escape codes. `key-id` prints the public fingerprint of RECEIPT_SIGNING_KEY (from the environment) and never
 * the key.
 */
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { EXPORT_FORMAT, deriveKeys, isKeyId, isUuid, verifyRunExport } from "../lib/receipts/chain.mjs";
import { AUDIT_FORMAT, verifyAuditExport } from "../lib/security/audit-chain.mjs";

export const MAX_INPUT_BYTES = 64 * 1024 * 1024;
export const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2 });

const USAGE = `Usage:
  eclipse-crew verify <run.json|-> [--key-id sha256:<hex>] [--json]
      Check a run's receipt chain and signature offline. "-" reads standard input.
      --key-id pins the signing key; without it the file is only shown to be intact and self-consistent.
  eclipse-crew verify-audit <audit.json|-> [--key-id sha256:<hex>] [--expect-seq <n>] [--json]
      Check an audit-log export's hash chain and signatures offline. "-" reads standard input.
      --expect-seq detects a log that was shortened after an earlier export: pass the entry count you saw before.
  eclipse-crew key-id
      Print this install's public signing-key fingerprint (reads RECEIPT_SIGNING_KEY from the environment).

Exit codes: 0 verified, 1 verification failed, 2 usage error or unreadable input.
`;

class InputError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === "help") return { help: true };
  if (command === "key-id") return rest.length ? { error: "key-id takes no arguments." } : { command: "key-id" };
  if (command === "verify-audit") {
    let file; let keyId; let json = false; let expectSeq;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === "--json") json = true;
      else if (arg === "--key-id" || arg.startsWith("--key-id=")) {
        const value = arg === "--key-id" ? rest[++i] : arg.slice("--key-id=".length);
        if (keyId !== undefined || !isKeyId(value)) return { error: "--key-id needs one value like sha256:<64 hex characters>." };
        keyId = value;
      } else if (arg === "--expect-seq" || arg.startsWith("--expect-seq=")) {
        const value = arg === "--expect-seq" ? rest[++i] : arg.slice("--expect-seq=".length);
        if (expectSeq !== undefined || typeof value !== "string" || !/^\d{1,9}$/.test(value)) return { error: "--expect-seq needs one whole entry count." };
        expectSeq = Number(value);
      } else if (arg === "-" || !arg.startsWith("-")) {
        if (file !== undefined) return { error: "Give one file." };
        file = arg;
      } else return { error: "Unknown option." };
    }
    return file === undefined ? { error: "Give a file, or - for standard input." } : { command: "verify-audit", file, keyId, json, expectSeq };
  }
  if (command !== "verify") return { error: command ? "Unknown command." : "Missing command." };
  let file; let keyId; let json = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--json") json = true;
    else if (arg === "--key-id" || arg.startsWith("--key-id=")) {
      const value = arg === "--key-id" ? rest[++i] : arg.slice("--key-id=".length);
      if (keyId !== undefined || !isKeyId(value)) return { error: "--key-id needs one value like sha256:<64 hex characters>." };
      keyId = value;
    } else if (arg === "-" || !arg.startsWith("-")) {
      if (file !== undefined) return { error: "Give one file." };
      file = arg;
    } else return { error: "Unknown option." };
  }
  return file === undefined ? { error: "Give a file, or - for standard input." } : { command: "verify", file, keyId, json };
}

function readFileLimited(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new InputError("unreadable");
    if (stat.size > MAX_INPUT_BYTES) throw new InputError("too_large");
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } catch (error) {
    throw error instanceof InputError ? error : new InputError("unreadable");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function readStreamLimited(stream) {
  const chunks = []; let total = 0;
  try {
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > MAX_INPUT_BYTES) throw new InputError("too_large");
      chunks.push(chunk);
    }
  } catch (error) {
    throw error instanceof InputError ? error : new InputError("unreadable");
  }
  return Buffer.concat(chunks).toString("utf8");
}

const INPUT_MESSAGE = { too_large: "The file is larger than 64 MiB.", unreadable: "Cannot read the file.", not_export: "This is not an Eclipse Crew run export." };

function parseExport(text, expected = EXPORT_FORMAT) {
  let value;
  try { value = JSON.parse(text); } catch { throw new InputError("not_export"); }
  if (value === null || typeof value !== "object" || Array.isArray(value) || value.format !== expected) throw new InputError("not_export");
  return value;
}

// Only values that passed validation are ever printed.
const safeRunId = (value) => (isUuid(value?.run_id) ? value.run_id : null);
const safeKeyId = (value) => (isKeyId(value?.key_id) ? value.key_id : null);

export async function main(argv, io = {}) {
  const out = io.stdout ?? process.stdout;
  const err = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;
  const stdin = io.stdin ?? process.stdin;
  const print = (stream, text) => { stream.write(`${text}\n`); };

  const args = parseArgs(argv);
  if (args.help) { out.write(USAGE); return EXIT.ok; }
  if (args.error) { print(err, args.error); err.write(USAGE); return EXIT.usage; }

  if (args.command === "key-id") {
    try {
      print(out, deriveKeys(env.RECEIPT_SIGNING_KEY).keyId);
      return EXIT.ok;
    } catch {
      print(err, "RECEIPT_SIGNING_KEY is not set or is not valid. Run npm run receipt-key, then start with: node --env-file=.env scripts/eclipse-crew.mjs key-id");
      return EXIT.usage;
    }
  }

  const audit = args.command === "verify-audit";
  let exported;
  try {
    const text = args.file === "-" ? await readStreamLimited(stdin) : (io.readFile ?? readFileLimited)(args.file);
    exported = parseExport(text, audit ? AUDIT_FORMAT : EXPORT_FORMAT);
  } catch (error) {
    const message = error?.code === "not_export" && audit ? "This is not an Eclipse Crew audit export." : INPUT_MESSAGE[error?.code] ?? INPUT_MESSAGE.unreadable;
    print(err, message);
    return EXIT.usage;
  }

  if (audit) {
    const options = {
      ...(args.keyId ? { pinnedKeyId: args.keyId } : {}),
      ...(args.expectSeq !== undefined ? { expectSeq: args.expectSeq } : {}),
    };
    const result = verifyAuditExport(exported, options);
    const ownerId = isUuid(exported.owner_id) ? exported.owner_id : null;
    const keyId = isKeyId(exported.key_id) ? exported.key_id : null;
    if (args.json) {
      print(out, JSON.stringify(result.ok
        ? { ok: true, reason: null, seq: null, owner_id: result.ownerId, key_id: result.keyId, entries: result.entries, head_seq: result.headSeq, head_hash: result.headHash, pinned: result.pinned }
        : { ok: false, reason: result.reason, seq: result.seq ?? null, owner_id: ownerId, key_id: keyId, entries: null, head_seq: null, head_hash: null, pinned: false }));
    } else if (result.ok) {
      print(out, `PASS  audit ${result.entries} entr${result.entries === 1 ? "y" : "ies"}  head ${result.headSeq}  key ${result.keyId}`);
      print(out, result.pinned
        ? "Key matches the pin you gave."
        : "Key not pinned: this shows the file is intact and was signed by the key above, not that the key is yours. Compare it with `eclipse-crew key-id` on your install, or pass --key-id.");
      print(out, "Truncation at the end is only detectable against an earlier export or with --expect-seq.");
    } else {
      print(out, `FAIL  ${result.reason}${result.seq === undefined ? "" : `  entry ${result.seq}`}`);
      if (ownerId) print(out, `owner ${ownerId}`);
    }
    return result.ok ? EXIT.ok : EXIT.failed;
  }

  const result = verifyRunExport(exported, args.keyId ? { pinnedKeyId: args.keyId } : {});
  const runId = safeRunId(exported); const keyId = safeKeyId(exported);
  if (args.json) {
    print(out, JSON.stringify(result.ok
      ? { ok: true, reason: null, step: null, run_id: result.runId, key_id: result.keyId, steps: result.steps, pinned: result.pinned }
      : { ok: false, reason: result.reason, step: result.step ?? null, run_id: runId, key_id: keyId, steps: null, pinned: false }));
  } else if (result.ok) {
    print(out, `PASS  run ${result.runId}  ${result.steps} step${result.steps === 1 ? "" : "s"}  sealed  key ${result.keyId}`);
    print(out, result.pinned
      ? "Key matches the pin you gave."
      : "Key not pinned: this shows the file is intact and was signed by the key above, not that the key is yours. Compare it with `eclipse-crew key-id` on your install, or pass --key-id.");
  } else {
    print(out, `FAIL  ${result.reason}${result.step === undefined ? "" : `  step ${result.step}`}`);
    if (runId) print(out, `run ${runId}`);
  }
  return result.ok ? EXIT.ok : EXIT.failed;
}

const isEntry = (() => {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isEntry) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, () => {
    console.error("Unexpected failure.");
    process.exitCode = EXIT.usage;
  });
}
