import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildHeader, buildReceipt, buildRunExport, deriveKeys, sealRun, sha256Hex } from "../lib/receipts/chain.mjs";
import { buildAuditEntry, buildAuditExport, genesisHash, signAuditEntry } from "../lib/security/audit-chain.mjs";

// These tests run the CLI with bare `node` (no tsx, no conditions, no environment from this project), the way anyone
// holding only the repository's script and a run.json would.
const CLI = path.resolve("scripts/eclipse-crew.mjs");
const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const OTHER_SEED = "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb";
const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KEY_ID = deriveKeys(SEED).keyId;
const ZERO = { input: 1, output: 1, cached: 0, reasoning: 0 };

function exportFor({ seed = SEED, count = 3, sealIt = true } = {}) {
  const keys = deriveKeys(seed);
  const header = buildHeader({ runId: RUN_ID, agentId: "11111111-1111-4111-8111-111111111111", agentName: "Ada", task: "Open the settings page.", startedAt: "2026-11-01T12:00:00.000Z", keyId: keys.keyId });
  const rows = []; let head = header.hash;
  for (let idx = 1; idx <= count; idx++) {
    const receipt = buildReceipt({ run_id: RUN_ID, idx, postcondition: `step ${idx}`, result: "pass" }, head);
    rows.push({ idx, receiptText: receipt.text, receiptHash: receipt.hash, prevHash: head });
    head = receipt.hash;
  }
  const seal = sealIt ? { status: "finished", endedAt: "2026-11-01T12:01:00.000Z", stepCount: count, headHash: head, usage: ZERO,
    signature: sealRun(keys.privateKey, { runId: RUN_ID, headerHash: header.hash, stepCount: count, headHash: head, status: "finished", endedAt: "2026-11-01T12:01:00.000Z", usage: ZERO }) } : null;
  return buildRunExport({ runId: RUN_ID, headerText: header.text, headerHash: header.hash, keyId: keys.keyId, publicKey: keys.publicKey, seal }, rows);
}

const OWNER_ID = "11111111-1111-4111-8111-111111111111";

function auditFor({ seed = SEED, count = 3 } = {}) {
  const keys = deriveKeys(seed);
  const rows = []; let head = genesisHash(OWNER_ID);
  for (let seq = 1; seq <= count; seq++) {
    const entry = buildAuditEntry({
      seq, kind: "login", agentId: null, runId: null, ref: null, code: null, host: null,
      ts: `2026-11-02T12:00:0${seq}.000Z`, prevHash: head,
    });
    rows.push({ seq, entryText: entry.text, entryHash: entry.hash, prevHash: head, signature: signAuditEntry(keys.privateKey, entry.hash) });
    head = entry.hash;
  }
  return buildAuditExport({ ownerId: OWNER_ID, keyId: keys.keyId, publicKey: keys.publicKey, exportedAt: "2026-11-02T12:05:00.000Z", entries: rows });
}

const cli = (args, { input, env } = {}) => spawnSync(process.execPath, [CLI, ...args], {
  encoding: "utf8", input, timeout: 30000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
});
let dir;
test.before(async () => { dir = await mkdtemp(path.join(tmpdir(), "verify-cli-")); });
test.after(async () => { await rm(dir, { recursive: true, force: true }); });
async function file(name, value) { const target = path.join(dir, name); await writeFile(target, typeof value === "string" ? value : JSON.stringify(value)); return target; }

test("an untouched export passes with exit 0, from a file and from standard input", async () => {
  const good = exportFor();
  const target = await file("good.json", good);
  const fromFile = cli(["verify", target]);
  assert.equal(fromFile.status, 0, fromFile.stderr);
  assert.match(fromFile.stdout, new RegExp(`^PASS  run ${RUN_ID}  3 steps  sealed  key ${KEY_ID}\\n`));
  assert.match(fromFile.stdout, /Key not pinned/);
  const fromStdin = cli(["verify", "-"], { input: JSON.stringify(good) });
  assert.equal(fromStdin.status, 0, fromStdin.stderr);
  assert.equal(fromStdin.stdout, fromFile.stdout);
  const one = cli(["verify", "-"], { input: JSON.stringify(exportFor({ count: 1 })) });
  assert.match(one.stdout, /1 step  sealed/);
});

test("--key-id pins the signing key: the right one passes without the warning, another fails", async () => {
  const target = await file("pin.json", exportFor());
  const right = cli(["verify", target, "--key-id", KEY_ID]);
  assert.equal(right.status, 0, right.stderr);
  assert.match(right.stdout, /Key matches the pin/); assert.doesNotMatch(right.stdout, /not pinned/);
  assert.equal(cli(["verify", target, `--key-id=${KEY_ID}`]).status, 0);
  const wrong = cli(["verify", target, "--key-id", deriveKeys(OTHER_SEED).keyId]);
  assert.equal(wrong.status, 1); assert.match(wrong.stdout, /^FAIL  pin_mismatch/);
  const forged = await file("forged.json", exportFor({ seed: OTHER_SEED }));
  assert.equal(cli(["verify", forged]).status, 0, "consistent but unpinned");
  assert.equal(cli(["verify", forged, "--key-id", KEY_ID]).status, 1, "signed by another key fails the pin");
});

test("every tampered export fails with exit 1 and the reason and step", async () => {
  const base = () => JSON.parse(JSON.stringify(exportFor({ count: 4 })));
  const cases = {
    altered: [(e) => { e.steps[1].receipt = e.steps[1].receipt.replace("step 2", "step X"); }, "receipt_hash_mismatch", 2],
    removed_middle: [(e) => { e.steps.splice(1, 1); }, "step_missing", 2],
    removed_last: [(e) => { e.steps.pop(); }, "step_count_mismatch", null],
    reordered: [(e) => { [e.steps[1], e.steps[2]] = [e.steps[2], e.steps[1]]; }, "step_order", 2],
    header: [(e) => { e.header = e.header.replace("Open the settings page.", "Move the money."); }, "header_hash_mismatch", null],
    status: [(e) => { e.seal.status = "step_limit"; }, "bad_signature", null],
    signature: [(e) => { e.seal.signature = Buffer.alloc(64, 7).toString("base64url"); }, "bad_signature", null],
    unsealed: [(e) => { e.seal = null; }, "unsealed", null],
    step_count: [(e) => { e.seal.step_count = 3; }, "step_count_mismatch", null],
  };
  for (const [name, [mutate, reason, step]] of Object.entries(cases)) {
    const data = base(); mutate(data);
    const result = cli(["verify", await file(`${name}.json`, data)]);
    assert.equal(result.status, 1, `${name}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, new RegExp(`^FAIL  ${reason}${step ? `  step ${step}` : ""}\\n`), name);
    const json = JSON.parse(cli(["verify", await file(`${name}.json`, data), "--json"]).stdout);
    assert.deepEqual([json.ok, json.reason, json.step], [false, reason, step], name);
  }
});

test("--json prints one machine-readable object", async () => {
  const target = await file("json.json", exportFor());
  const pass = cli(["verify", target, "--json", "--key-id", KEY_ID]);
  assert.equal(pass.status, 0);
  assert.deepEqual(JSON.parse(pass.stdout), { ok: true, reason: null, step: null, run_id: RUN_ID, key_id: KEY_ID, steps: 3, pinned: true });
});

test("unreadable, oversized, malformed or foreign input exits 2 and says nothing about the file", async () => {
  const notJson = cli(["verify", await file("garbage.json", "{not json")]);
  const foreign = cli(["verify", await file("foreign.json", { format: "something-else" })]);
  const array = cli(["verify", await file("array.json", "[]")]);
  const missing = cli(["verify", path.join(dir, "missing.json")]);
  const directory = cli(["verify", dir]);
  for (const result of [notJson, foreign, array, missing, directory]) { assert.equal(result.status, 2, `${result.stdout}${result.stderr}`); assert.equal(result.stdout, ""); }
  assert.match(notJson.stderr, /not an Eclipse Crew run export/); assert.match(missing.stderr, /Cannot read/);
  assert.ok(!missing.stderr.includes("missing.json"), "paths are not echoed");
  const empty = cli(["verify", "-"], { input: "" });
  assert.equal(empty.status, 2);
  // 64 MiB limit, checked before parsing.
  const { MAX_INPUT_BYTES, main } = await import("../scripts/eclipse-crew.mjs");
  const written = []; const sink = { write: (text) => { written.push(text); } };
  const code = await main(["verify", "-"], { stdout: sink, stderr: sink, stdin: (async function* () { yield Buffer.alloc(MAX_INPUT_BYTES / 2); yield Buffer.alloc(MAX_INPUT_BYTES / 2 + 1); })() });
  assert.equal(code, 2); assert.match(written.join(""), /larger than 64 MiB/);
});

test("usage errors exit 2: unknown commands and options, bad pins, missing or extra files", async () => {
  const target = await file("usage.json", exportFor());
  for (const args of [[], ["bogus"], ["verify"], ["verify", target, "extra"], ["verify", target, "--nope"], ["verify", target, "--key-id"],
    ["verify", target, "--key-id", "sha256:short"], ["verify", target, "--key-id", KEY_ID, "--key-id", KEY_ID], ["key-id", "x"]]) {
    const result = cli(args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.match(result.stderr, /Usage:/);
  }
  const help = cli(["--help"]);
  assert.equal(help.status, 0); assert.match(help.stdout, /eclipse-crew verify/);
});

test("a crafted file cannot send terminal escape codes or file-supplied text to the screen", async () => {
  const evil = JSON.parse(JSON.stringify(exportFor()));
  evil.run_id = "\u001b]0;pwned\u0007 not-a-uuid";
  evil.key_id = "\u001b[2J sha256:xyz";
  evil.header = "\u001b[31mred";
  for (const args of [[], ["--json"]]) {
    const result = cli(["verify", await file("evil.json", evil), ...args]);
    assert.equal(result.status, 1);
    assert.ok(!/[\u001b\u0007]/.test(result.stdout + result.stderr), "no control characters in output");
    assert.ok(!/pwned|red/.test(result.stdout + result.stderr), "no file text in output");
  }
  const evilStep = JSON.parse(JSON.stringify(exportFor()));
  evilStep.steps[0].receipt = evilStep.steps[0].receipt.replace("step 1", "\u001b[31mstep");
  const result = cli(["verify", await file("evil-step.json", evilStep)]);
  assert.equal(result.status, 1); assert.ok(!/\u001b/.test(result.stdout));
});

test("key-id prints only the public fingerprint, and never the seed, even on bad input", () => {
  const ok = cli(["key-id"], { env: { RECEIPT_SIGNING_KEY: SEED } });
  assert.equal(ok.status, 0, ok.stderr); assert.equal(ok.stdout.trim(), KEY_ID);
  assert.ok(!(ok.stdout + ok.stderr).includes(SEED));
  for (const bad of [undefined, "", "not-hex", SEED.toUpperCase(), `${SEED}00`]) {
    const result = cli(["key-id"], { env: bad === undefined ? {} : { RECEIPT_SIGNING_KEY: bad } });
    assert.equal(result.status, 2); assert.equal(result.stdout, "");
    assert.match(result.stderr, /npm run receipt-key/);
    if (bad) assert.ok(!result.stderr.includes(bad));
  }
});

test("the command is standalone and works through a symlink from another directory", async (t) => {
  const link = path.join(dir, "eclipse-crew-link.mjs");
  try { await symlink(CLI, link); } catch { t.skip("symlinks are not available here"); return; }
  const target = await file("link.json", exportFor());
  const result = spawnSync(process.execPath, [link, "verify", target], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^PASS/);
});

test("verify-audit checks a real export, pins the key and detects truncation", async () => {
  const good = await file("audit.json", auditFor());
  const pass = cli(["verify-audit", good]);
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /^PASS  audit 3 entries  head 3  key /);
  assert.match(pass.stdout, /not pinned/);
  const pinned = cli(["verify-audit", good, "--key-id", KEY_ID]);
  assert.equal(pinned.status, 0); assert.match(pinned.stdout, /matches the pin/);
  const wrong = cli(["verify-audit", good, "--key-id", deriveKeys(OTHER_SEED).keyId]);
  assert.equal(wrong.status, 1); assert.match(wrong.stdout, /^FAIL  pin_mismatch/);
  const short = auditFor(); short.entries.pop();
  const truncated = cli(["verify-audit", await file("audit-short.json", short), "--expect-seq", "3"]);
  assert.equal(truncated.status, 1); assert.match(truncated.stdout, /^FAIL  seq_pin_mismatch/);
  const json = JSON.parse(cli(["verify-audit", good, "--json", "--key-id", KEY_ID]).stdout);
  assert.deepEqual([json.ok, json.entries, json.head_seq, json.owner_id], [true, 3, 3, OWNER_ID]);
});

test("verify-audit rejects a tampered entry, a foreign file and a bad --expect-seq", async () => {
  const tampered = JSON.parse(JSON.stringify(auditFor()));
  tampered.entries[1].entry = tampered.entries[1].entry.replace("login", "agent_deleted");
  const fail = cli(["verify-audit", await file("audit-tampered.json", tampered)]);
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /^FAIL  entry_hash_mismatch  entry 2/);
  const foreign = await file("audit-foreign.json", exportFor());
  assert.equal(cli(["verify-audit", foreign]).status, 2);
  assert.match(cli(["verify-audit", foreign]).stderr, /not an Eclipse Crew audit export/);
  for (const bad of [["--expect-seq"], ["--expect-seq", "x"], ["--expect-seq", "3", "--expect-seq", "3"], ["--nope"]]) {
    assert.equal(cli(["verify-audit", await file("audit.json", auditFor()), ...bad]).status, 2, JSON.stringify(bad));
  }
});

test("the command imports only Node built-ins and its two chain modules, and does no network or database work", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(CLI, "utf8");
  const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(imports.filter((name) => !name.startsWith("node:")), ["../lib/receipts/chain.mjs", "../lib/security/audit-chain.mjs"]);
  assert.doesNotMatch(source, /fetch\(|node:(http|https|net|dns|tls|child_process)|process\.env\.(DATABASE|ENCRYPTION)/);
  const chain = await readFile(path.resolve("lib/receipts/chain.mjs"), "utf8");
  assert.deepEqual([...chain.matchAll(/from "([^"]+)"/g)].map((match) => match[1]), ["node:crypto"]);
  assert.doesNotMatch(chain, /process\.env|fetch\(|server-only/);
  const audit = await readFile(path.resolve("lib/security/audit-chain.mjs"), "utf8");
  assert.deepEqual([...audit.matchAll(/from "([^"]+)"/g)].map((match) => match[1]), ["node:crypto", "../receipts/chain.mjs"]);
  assert.doesNotMatch(audit, /process\.env|fetch\(|server-only/);
  assert.equal(sha256Hex("a").length, 64);
});
