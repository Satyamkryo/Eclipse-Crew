import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { decryptSecret, encryptSecret } from "../lib/security/encryption.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const setupSource = path.join(root, "scripts", "encryption-key.mjs");
const helperSource = path.join(root, "scripts", "lib", "env-secret.mjs");
const KEY_A = "0123456789abcdef".repeat(4);
const KEY_B = "fedcba9876543210".repeat(4);
const PLAINTEXT = "synthetic-provider-canary-\u{1f511}-\u00e9";
const originalKey = process.env.ENCRYPTION_KEY;

function setKey(value) {
  if (value === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = value;
}

function withKey(value, operation) {
  setKey(value);
  try {
    return operation();
  } finally {
    setKey(originalKey);
  }
}

function assertDecryptRejected(envelope) {
  assert.throws(() => decryptSecret(envelope), (error) => {
    assert.equal(error.message, "Unable to decrypt value.");
    assert.ok(!error.message.includes(PLAINTEXT));
    assert.ok(!error.message.includes(KEY_A));
    assert.ok(!error.message.includes(KEY_B));
    return true;
  });
}

function assertDecryptFailure(envelope, key = KEY_A) {
  withKey(key, () => assertDecryptRejected(envelope));
}

function makeFixture() {
  const tempRoot = realpathSync(tmpdir());
  const directory = mkdtempSync(path.join(tempRoot, "eclipse-encryption-test-"));
  mkdirSync(path.join(directory, "scripts"));
  mkdirSync(path.join(directory, "scripts", "lib"));
  copyFileSync(setupSource, path.join(directory, "scripts", "encryption-key.mjs"));
  copyFileSync(helperSource, path.join(directory, "scripts", "lib", "env-secret.mjs"));
  return { directory, tempRoot };
}

function removeFixture({ directory, tempRoot }) {
  const resolved = realpathSync(directory);
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith("eclipse-encryption-test-")) {
    throw new Error("Unsafe test directory cleanup target");
  }
  rmSync(resolved, { recursive: true, force: true });
}

function runSetup(directory) {
  return spawnSync(process.execPath, [path.join(directory, "scripts", "encryption-key.mjs")], {
    cwd: directory,
    encoding: "utf8",
    timeout: 15000,
  });
}

test("encryption round-trips exact UTF-8 plaintext with a fresh authenticated envelope", () => {
  withKey(KEY_A, () => {
    const first = encryptSecret(PLAINTEXT);
    const second = encryptSecret(PLAINTEXT);
    assert.match(first, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.notEqual(first, second);
    assert.notEqual(first.split(".")[1], second.split(".")[1]);
    assert.ok(!first.includes(PLAINTEXT));
    assert.equal(decryptSecret(first), PLAINTEXT);
    assert.equal(decryptSecret(second), PLAINTEXT);
    assert.equal(decryptSecret(encryptSecret("")), "");
    assert.throws(() => encryptSecret("a\uD800b"), /well-formed Unicode/);
  });
});

test("encryption rejects missing, malformed and wrong keys without leaking them", () => {
  for (const key of [undefined, "", "A".repeat(64), "a".repeat(63), `${KEY_A}\n`]) {
    withKey(key, () => assert.throws(() => encryptSecret(PLAINTEXT), /ENCRYPTION_KEY/));
  }

  const envelope = withKey(KEY_A, () => encryptSecret(PLAINTEXT));
  assertDecryptFailure(envelope, KEY_B);
  withKey(undefined, () => assert.throws(() => decryptSecret(envelope), /ENCRYPTION_KEY/));
});

test("decryption rejects every modified envelope component and malformed encoding", () => {
  const envelope = withKey(KEY_A, () => encryptSecret(PLAINTEXT));
  const [version, nonce, tag, ciphertext] = envelope.split(".");

  for (const [index, value] of [version, nonce, tag, ciphertext].entries()) {
    const changed = [version, nonce, tag, ciphertext];
    changed[index] = `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
    assertDecryptFailure(changed.join("."));
  }

  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const noncanonicalTag = `${tag.slice(0, -1)}${alphabet[alphabet.indexOf(tag.at(-1)) + 1]}`;
  assert.equal(Buffer.from(noncanonicalTag, "base64url").toString("base64url"), tag);

  for (const malformed of [
    "", "v1", `${version}.${nonce}.${tag}`, `${version}.${nonce}.${tag}.${ciphertext}.extra`,
    `v2.${nonce}.${tag}.${ciphertext}`, `${version}.${nonce}.${tag}.${ciphertext}=`,
    `${version}.${nonce}.${tag}.${ciphertext}!`, `${version}.AAAA.${tag}.${ciphertext}`,
    `${version}.${nonce}.AAAA.${ciphertext}`, `${version}.${nonce}.${tag}.AAAA`,
    `${version}.${nonce}.${noncanonicalTag}.${ciphertext}`,
  ]) {
    assertDecryptFailure(malformed);
  }
  withKey(KEY_A, () => assert.throws(() => decryptSecret(null), /Unable to decrypt value/));
});

test("key setup creates a private key, stays idempotent and never prints it", () => {
  const fixture = makeFixture();
  try {
    const first = runSetup(fixture.directory);
    assert.equal(first.status, 0, first.stderr);
    assert.ok(!first.stdout.includes(KEY_A));
    const envPath = path.join(fixture.directory, ".env");
    const contents = readFileSync(envPath, "utf8");
    const match = /^ENCRYPTION_KEY=([0-9a-f]{64})$/m.exec(contents);
    assert.ok(match, "setup must write one canonical key");
    assert.ok(!first.stdout.includes(match[1]));
    assert.ok(!first.stderr.includes(match[1]));
    if (process.platform !== "win32") assert.equal(lstatSync(envPath).mode & 0o777, 0o600);

    const second = runSetup(fixture.directory);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(envPath, "utf8"), contents);
    assert.match(second.stdout, /already set/);
  } finally {
    removeFixture(fixture);
  }
});

test("key setup fills an empty entry while preserving unrelated content", () => {
  const fixture = makeFixture();
  const envPath = path.join(fixture.directory, ".env");
  const before = "# private settings\nOTHER=SYNTHETIC_VALUE\nENCRYPTION_KEY=\nTAIL=preserved\n";
  try {
    writeFileSync(envPath, before);
    const result = runSetup(fixture.directory);
    assert.equal(result.status, 0, result.stderr);
    const after = readFileSync(envPath, "utf8");
    assert.ok(after.startsWith("# private settings\nOTHER=SYNTHETIC_VALUE\nENCRYPTION_KEY="));
    assert.match(after, /^ENCRYPTION_KEY=[0-9a-f]{64}$/m);
    assert.ok(after.endsWith("TAIL=preserved\n"));
    if (process.platform !== "win32") assert.equal(lstatSync(envPath).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(fixture.directory).filter((name) => name.startsWith(".env.")), []);
  } finally {
    removeFixture(fixture);
  }
});

test("key setup preserves CRLF while filling the key", () => {
  const fixture = makeFixture();
  const envPath = path.join(fixture.directory, ".env");
  try {
    writeFileSync(envPath, "OTHER=one\r\nENCRYPTION_KEY=\r\nTAIL=two\r\n");
    const result = runSetup(fixture.directory);
    assert.equal(result.status, 0, result.stderr);
    const after = readFileSync(envPath, "utf8");
    assert.match(after, /^OTHER=one\r\nENCRYPTION_KEY=[0-9a-f]{64}\r\nTAIL=two\r\n$/);
  } finally {
    removeFixture(fixture);
  }
});

test("key setup appends with the last line's ending in a mixed-ending file", () => {
  const fixture = makeFixture();
  const envPath = path.join(fixture.directory, ".env");
  try {
    writeFileSync(envPath, "FIRST=one\r\nSECOND=two\n");
    assert.equal(runSetup(fixture.directory).status, 0);
    assert.match(readFileSync(envPath, "utf8"), /^FIRST=one\r\nSECOND=two\nENCRYPTION_KEY=[0-9a-f]{64}\n$/);
  } finally {
    removeFixture(fixture);
  }
});

test("key setup refuses malformed and conflicting keys without changing the file", () => {
  const fixture = makeFixture();
  const envPath = path.join(fixture.directory, ".env");
  try {
    for (const before of [
      "OTHER=preserved\nENCRYPTION_KEY=NOT_A_VALID_KEY\nTAIL=preserved\n",
      `ENCRYPTION_KEY=${KEY_A}\nENCRYPTION_KEY=${KEY_B}\n`,
      `OTHER=preserved\nENCRYPTION_KEY=${KEY_A} \nTAIL=preserved\n`,
      `OTHER=preserved\nENCRYPTION_KEY=\t${KEY_A}\nTAIL=preserved\n`,
    ]) {
      writeFileSync(envPath, before);
      const result = runSetup(fixture.directory);
      assert.equal(result.status, 1);
      assert.equal(readFileSync(envPath, "utf8"), before);
      assert.ok(!result.stdout.includes(KEY_A));
      assert.ok(!result.stderr.includes(KEY_A));
      assert.ok(!result.stderr.includes("NOT_A_VALID_KEY"));
    }
  } finally {
    removeFixture(fixture);
  }
});

test("Compose passes the encryption key only to the app service", (t) => {
  const available = spawnSync("docker", ["compose", "version"], { encoding: "utf8", timeout: 10000 });
  if (available.error || available.status !== 0) {
    t.skip("Docker Compose is unavailable");
    return;
  }
  const result = spawnSync("docker", ["compose", "config", "--format", "json"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ENCRYPTION_KEY: KEY_A },
    timeout: 30000,
  });
  assert.equal(result.status, 0, "Compose configuration must parse");
  const services = JSON.parse(result.stdout).services;
  const exposed = Object.entries(services)
    .filter(([, service]) => service.environment?.ENCRYPTION_KEY !== undefined)
    .map(([name]) => name);
  assert.deepEqual(exposed, ["app"]);
  assert.equal(services.app.environment.ENCRYPTION_KEY, KEY_A);
});

test("key setup refuses a symlinked .env", (t) => {
  const fixture = makeFixture();
  const envPath = path.join(fixture.directory, ".env");
  const target = path.join(fixture.directory, "target.env");
  try {
    writeFileSync(target, "OTHER=preserved\n");
    try {
      symlinkSync(target, envPath, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.skip(`symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const result = runSetup(fixture.directory);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /symlink/);
    assert.equal(readFileSync(target, "utf8"), "OTHER=preserved\n");
  } finally {
    removeFixture(fixture);
  }
});
