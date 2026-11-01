import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ensureEnvSecret } from "../scripts/lib/env-secret.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "DESKTOP_CONTROL_SECRET";
const SECRET_A = "0123456789abcdef".repeat(4);
const SECRET_B = "fedcba9876543210".repeat(4);

function makeFixture() {
  const tempRoot = realpathSync(tmpdir());
  const directory = mkdtempSync(path.join(tempRoot, "eclipse-desktop-secret-test-"));
  mkdirSync(path.join(directory, "scripts", "lib"), { recursive: true });
  copyFileSync(path.join(root, "scripts", "desktop-secret.mjs"), path.join(directory, "scripts", "desktop-secret.mjs"));
  copyFileSync(path.join(root, "scripts", "lib", "env-secret.mjs"), path.join(directory, "scripts", "lib", "env-secret.mjs"));
  return { directory, tempRoot, envPath: path.join(directory, ".env") };
}

function removeFixture({ directory, tempRoot }) {
  const resolved = realpathSync(directory);
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith("eclipse-desktop-secret-test-")) {
    throw new Error("Unsafe test directory cleanup target");
  }
  rmSync(resolved, { recursive: true, force: true });
}

function run(fixture) {
  return spawnSync(process.execPath, [path.join(fixture.directory, "scripts", "desktop-secret.mjs")], {
    cwd: fixture.directory,
    encoding: "utf8",
    timeout: 15000,
  });
}

function withFixture(operation) {
  const fixture = makeFixture();
  try {
    return operation(fixture);
  } finally {
    removeFixture(fixture);
  }
}

test("creates a private file, stays idempotent and never prints the secret", () => {
  withFixture((fixture) => {
    const first = run(fixture);
    assert.equal(first.status, 0, first.stderr);
    const contents = readFileSync(fixture.envPath, "utf8");
    const match = /^DESKTOP_CONTROL_SECRET=([0-9a-f]{64})\n$/.exec(contents);
    assert.ok(match, "one canonical secret line");
    assert.ok(!first.stdout.includes(match[1]) && !first.stderr.includes(match[1]));
    if (process.platform !== "win32") assert.equal(lstatSync(fixture.envPath).mode & 0o777, 0o600);

    const second = run(fixture);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /already set/);
    assert.equal(readFileSync(fixture.envPath, "utf8"), contents);
  });
});

test("fills an empty entry and preserves unrelated content byte-for-byte", () => {
  withFixture((fixture) => {
    writeFileSync(fixture.envPath, "# private\nOTHER=SYNTHETIC\nDESKTOP_CONTROL_SECRET=\nTAIL=kept\n");
    const result = run(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(fixture.envPath, "utf8"), /^# private\nOTHER=SYNTHETIC\nDESKTOP_CONTROL_SECRET=[0-9a-f]{64}\nTAIL=kept\n$/);
    assert.deepEqual(readdirSync(fixture.directory).filter((name) => name.startsWith(".env.")), []);
  });
});

test("a CRLF file with a valid secret is left unchanged: no duplicate, no rotation", () => {
  withFixture((fixture) => {
    const before = `MODEL_API_KEY=synthetic\r\nDESKTOP_CONTROL_SECRET=${SECRET_A}\r\nTAIL=kept\r\n`;
    writeFileSync(fixture.envPath, before);
    const result = run(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /already set/);
    assert.equal(readFileSync(fixture.envPath, "utf8"), before);
  });
});

test("a CRLF empty entry is filled and keeps CRLF", () => {
  withFixture((fixture) => {
    writeFileSync(fixture.envPath, "OTHER=one\r\nDESKTOP_CONTROL_SECRET=\r\nTAIL=two\r\n");
    assert.equal(run(fixture).status, 0);
    assert.match(readFileSync(fixture.envPath, "utf8"), /^OTHER=one\r\nDESKTOP_CONTROL_SECRET=[0-9a-f]{64}\r\nTAIL=two\r\n$/);
  });
});

test("appending uses the last line's ending, and adds a missing final newline", () => {
  withFixture((fixture) => {
    writeFileSync(fixture.envPath, "A=1\r\nB=2\n");
    assert.equal(run(fixture).status, 0);
    assert.match(readFileSync(fixture.envPath, "utf8"), /^A=1\r\nB=2\nDESKTOP_CONTROL_SECRET=[0-9a-f]{64}\n$/);

    writeFileSync(fixture.envPath, "A=1\nB=2\r\n");
    assert.equal(run(fixture).status, 0);
    assert.match(readFileSync(fixture.envPath, "utf8"), /^A=1\nB=2\r\nDESKTOP_CONTROL_SECRET=[0-9a-f]{64}\r\n$/);

    writeFileSync(fixture.envPath, "A=1\nB=2");
    assert.equal(run(fixture).status, 0);
    assert.match(readFileSync(fixture.envPath, "utf8"), /^A=1\nB=2\nDESKTOP_CONTROL_SECRET=[0-9a-f]{64}\n$/);
  });
});

test("refuses invalid, padded, duplicate and unsupported entries without changing the file", () => {
  withFixture((fixture) => {
    for (const before of [
      "OTHER=kept\nDESKTOP_CONTROL_SECRET=NOT_A_VALID_SECRET\n",
      `DESKTOP_CONTROL_SECRET=${SECRET_A.toUpperCase()}\n`,
      `DESKTOP_CONTROL_SECRET=${SECRET_A} \n`,
      `DESKTOP_CONTROL_SECRET=\t${SECRET_A}\n`,
      `DESKTOP_CONTROL_SECRET=${SECRET_A}\nDESKTOP_CONTROL_SECRET=${SECRET_B}\n`,
      `export DESKTOP_CONTROL_SECRET=${SECRET_A}\n`,
      ` DESKTOP_CONTROL_SECRET=${SECRET_A}\n`,
      `DESKTOP_CONTROL_SECRET = ${SECRET_A}\n`,
    ]) {
      writeFileSync(fixture.envPath, before);
      const result = run(fixture);
      assert.equal(result.status, 1, `expected failure for ${JSON.stringify(before)}`);
      assert.equal(readFileSync(fixture.envPath, "utf8"), before);
      for (const secret of [SECRET_A, SECRET_B, SECRET_A.toUpperCase(), "NOT_A_VALID_SECRET"]) {
        assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
      }
    }
  });
});

test("refuses a symlinked or non-regular .env", (t) => {
  withFixture((fixture) => {
    const target = path.join(fixture.directory, "target.env");
    writeFileSync(target, "OTHER=kept\n");
    try {
      symlinkSync(target, fixture.envPath, "file");
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
      t.diagnostic(`symlinks unavailable: ${error.code}`);
    }
    if (lstatSync(fixture.envPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
      const result = run(fixture);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /symlink/);
      assert.equal(readFileSync(target, "utf8"), "OTHER=kept\n");
      rmSync(fixture.envPath);
    }

    mkdirSync(fixture.envPath);
    const directoryResult = run(fixture);
    assert.equal(directoryResult.status, 1);
    assert.match(directoryResult.stderr, /not a regular file/);
  });
});

test("a failed write leaves the original .env intact and removes the temp file", async () => {
  const fixture = makeFixture();
  try {
    const before = "MODEL_API_KEY=synthetic\nDESKTOP_CONTROL_SECRET=\nTAIL=kept\n";
    writeFileSync(fixture.envPath, before);
    const result = await ensureEnvSecret({
      envPath: fixture.envPath,
      key: KEY,
      renameFile: async () => {
        throw Object.assign(new Error("blocked"), { code: "EIO" });
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /EIO/);
    assert.equal(readFileSync(fixture.envPath, "utf8"), before);
    assert.deepEqual(readdirSync(fixture.directory).filter((name) => name.startsWith(".env.")), []);
  } finally {
    removeFixture(fixture);
  }
});

test("an existing world-readable .env becomes mode 600", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permissions are not enforced on Windows");
    return;
  }
  withFixture((fixture) => {
    writeFileSync(fixture.envPath, "OTHER=kept\n");
    chmodSync(fixture.envPath, 0o644);
    assert.equal(run(fixture).status, 0);
    assert.equal(lstatSync(fixture.envPath).mode & 0o777, 0o600);
  });
});
