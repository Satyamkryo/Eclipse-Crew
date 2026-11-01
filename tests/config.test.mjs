import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { requireDatabaseUrl, requireAppOrigin, requireEncryptionKey } from "../lib/config/server.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "node_modules", "drizzle-kit", "bin.cjs");
const config = path.join(root, "drizzle.config.ts");

test("APP_ORIGIN requires canonical scheme, host and port without extra URL components", () => {
  for (const value of ["http://127.0.0.1:3000", "https://crew.example.test", "http://localhost:4000"])
    assert.equal(requireAppOrigin(value), value);
  for (const value of [null, "", "null", "http://127.0.0.1:3000/", "http://127.0.0.1:3000/path", "https://user:CANARY@crew.example.test", "https://crew.example.test?q=CANARY", "ftp://example.test", "http://127.0.0.1:3000#CANARY"])
    assert.throws(() => requireAppOrigin(value), (error) => !error.message.includes("CANARY"));
});

test("ENCRYPTION_KEY accepts only one canonical 256-bit lowercase key", () => {
  const valid = "0123456789abcdef".repeat(4);
  const original = process.env.ENCRYPTION_KEY;
  assert.equal(requireEncryptionKey(valid), valid);
  try {
    delete process.env.ENCRYPTION_KEY;
    assert.throws(() => requireEncryptionKey(), (error) => {
      assert.match(error.message, /ENCRYPTION_KEY/);
      return true;
    });
  } finally {
    if (original === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = original;
  }
  for (const value of [null, "", valid.toUpperCase(), "a".repeat(63), "a".repeat(65),
    `${valid}\n`, ` ${valid}`, `${valid} `, `${valid}0`, "g".repeat(64), "CANARY".repeat(10) + "CANARY"]) {
    assert.throws(() => requireEncryptionKey(value), (error) => {
      assert.match(error.message, /ENCRYPTION_KEY/);
      assert.ok(!error.message.includes("CANARY"));
      assert.ok(!error.message.includes(valid));
      return true;
    });
  }
});

test("accepts URLs using the designated PostgreSQL role", () => {
  for (const [name, role] of [["DATABASE_URL", "eclipse_app"], ["MIGRATION_DATABASE_URL", "eclipse_migrator"]]) {
    for (const value of [`postgres://${role}:pass@localhost/db`, `postgresql://${role}:pass@localhost:5432/database`]) {
      assert.equal(requireDatabaseUrl(name, value), value);
    }
  }
});

test("rejects privileged, swapped, missing-password, and parameter-override URLs", () => {
  for (const [name, role, other] of [["DATABASE_URL", "eclipse_app", "eclipse_migrator"], ["MIGRATION_DATABASE_URL", "eclipse_migrator", "eclipse_app"]]) {
    for (const value of [`postgres://eclipse_bootstrap:CANARY@localhost/db`, `postgres://${other}:CANARY@localhost/db`, `postgres://${role}@localhost/db`, `postgres://${role}:CANARY@localhost/db?user=eclipse_bootstrap`]) {
      assert.throws(() => requireDatabaseUrl(name, value), (error) => !error.message.includes("CANARY"));
    }
  }
});

test("rejects missing or invalid URLs without revealing input", () => {
  const canary = "SYNTHETIC_CANARY_SECRET";
  for (const name of ["DATABASE_URL", "MIGRATION_DATABASE_URL"]) {
    for (const value of [undefined, "", "not-a-url", `https://user:${canary}@example.test/db`, "postgres://localhost/", `postgres://localhost/${canary} `]) {
      assert.throws(() => requireDatabaseUrl(name, value), (error) => {
        assert.match(error.message, new RegExp(name));
        assert.ok(!error.message.includes(canary));
        return true;
      });
    }
  }
});

test("migration CLI loads .env, respects shell precedence, and redacts errors", () => {
  const tempRoot = realpathSync(tmpdir());
  const temp = mkdtempSync(path.join(tempRoot, "eclipse-config-test-"));
  const run = (setting) => {
    const env = { ...process.env };
    delete env.MIGRATION_DATABASE_URL;
    delete env.DATABASE_URL;
    if (setting !== undefined) env.MIGRATION_DATABASE_URL = setting;
    return spawnSync(process.execPath, ["--conditions=react-server", cli, "migrate", "--config", config], {
      cwd: temp,
      env,
      encoding: "utf8",
      timeout: 15000,
    });
  };

  try {
    for (const [fileValue, setting] of [
      ["https://FILE_CANARY_SECRET@example.test/db", undefined],
      ["postgres://file-user:FILE_CANARY_SECRET@localhost/db", "https://SHELL_CANARY_SECRET@example.test/db"],
    ]) {
      writeFileSync(path.join(temp, ".env"), `MIGRATION_DATABASE_URL=${fileValue}\n`);
      const result = run(setting);
      assert.equal(result.status, 1, result.error?.message);
      const output = result.stdout + result.stderr;
      assert.match(output, /MIGRATION_DATABASE_URL must be a PostgreSQL URL/);
      assert.doesNotMatch(output, /FILE_CANARY_SECRET|SHELL_CANARY_SECRET/);
    }
  } finally {
    const resolved = realpathSync(temp);
    if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith("eclipse-config-test-")) {
      throw new Error("Unsafe test directory cleanup target");
    }
    rmSync(resolved, { recursive: true, force: true });
  }
});
