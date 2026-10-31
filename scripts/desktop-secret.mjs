#!/usr/bin/env node
/**
 * Generates DESKTOP_CONTROL_SECRET in the local .env file only if it is
 * missing or empty. Never prints credentials. Never rotates an existing valid value.
 * Reads and rewrites .env preserving all other entries.
 * Refuses to operate if .env is a symlink.
 * Exits with code 1 on any conflict or error.
 */
import { randomBytes } from "node:crypto";
import { readFile, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.join(ROOT, ".env");
const SECRET_KEY = "DESKTOP_CONTROL_SECRET";
const SECRET_PATTERN = /^[0-9a-f]{64}$/;

async function main() {
  // 1. Refuse if .env is a symlink
  let stat;
  try {
    stat = await lstat(ENV_PATH);
  } catch (err) {
    if (err.code === "ENOENT") {
      // .env doesn't exist — create it with just the secret
      const secret = randomBytes(32).toString("hex");
      await writeFile(ENV_PATH, `${SECRET_KEY}=${secret}\n`, { mode: 0o600, flag: "wx" });
      console.log(`Created .env with ${SECRET_KEY}.`);
      return;
    }
    console.error(`Error accessing .env: ${err.code ?? err.message}`);
    process.exit(1);
  }

  if (stat.isSymbolicLink()) {
    console.error(".env is a symlink — refusing to modify it.");
    process.exit(1);
  }

  // 2. Read existing .env
  let contents;
  try {
    contents = await readFile(ENV_PATH, "utf8");
  } catch (err) {
    console.error(`Failed to read .env: ${err.code ?? err.message}`);
    process.exit(1);
  }

  // 3. Parse lines preserving structure
  const lines = contents.split("\n");

  // Find existing DESKTOP_CONTROL_SECRET line
  let secretLineIndex = -1;
  let existingValue = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = /^DESKTOP_CONTROL_SECRET=(.*)$/.exec(line);
    if (match) {
      secretLineIndex = i;
      existingValue = match[1].trim();
      break;
    }
  }

  // 4. If there's already a valid secret, leave it untouched
  if (existingValue && SECRET_PATTERN.test(existingValue)) {
    console.log(`${SECRET_KEY} is already set; no changes made.`);
    return;
  }

  // 5. Validate: if there's a non-empty but invalid value, refuse
  if (existingValue && existingValue.length > 0) {
    console.error(`${SECRET_KEY} exists but is not a valid 64-character hex string. Remove it manually and re-run.`);
    process.exit(1);
  }

  // 6. Generate new secret
  const secret = randomBytes(32).toString("hex");

  // 7. Update or append the line
  if (secretLineIndex >= 0) {
    lines[secretLineIndex] = `${SECRET_KEY}=${secret}`;
  } else {
    // Append at end — ensure trailing newline
    if (lines[lines.length - 1] !== "") lines.push("");
    lines.push(`${SECRET_KEY}=${secret}`);
  }

  // 8. Write back
  const newContents = lines.join("\n");
  try {
    await writeFile(ENV_PATH, newContents, { mode: 0o600 });
  } catch (err) {
    console.error(`Failed to write .env: ${err.code ?? err.message}`);
    process.exit(1);
  }

  console.log(`${SECRET_KEY} has been generated and written to .env.`);
}

main().catch((err) => {
  console.error(`Unexpected error: ${err.message}`);
  process.exit(1);
});
