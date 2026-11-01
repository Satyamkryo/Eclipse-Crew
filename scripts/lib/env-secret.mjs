/**
 * Shared, hardened writer for generated 64-hex secrets in the local .env file.
 * Used by scripts/encryption-key.mjs and scripts/desktop-secret.mjs.
 *
 * - Never prints a secret or any other .env value.
 * - Never rotates an existing valid value and never overwrites an invalid one.
 * - Refuses symlinks, non-regular files, duplicate keys and padded values.
 * - Writes through a private temp file and an atomic rename, so an interrupted
 *   write cannot truncate .env. The final file is always mode 600.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";

const SECRET_PATTERN = /^[0-9a-f]{64}$/;
const KEY_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

async function writePrivate(envPath, contents, renameFile) {
  const temporary = `${envPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await renameFile(temporary, envPath);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

async function readExisting(envPath) {
  const file = await open(envPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("not a regular file");
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

/** Line ending of the last line of existing content; LF when unknown. */
function detectEol(contents) {
  // Index of the last "\n": the final character if the file ends with one,
  // otherwise the terminator of the previous line.
  const terminator = contents.lastIndexOf("\n");
  return terminator > 0 && contents[terminator - 1] === "\r" ? "\r\n" : "\n";
}

/**
 * Ensure `key` holds a generated 64-character lowercase hex secret in `envPath`.
 * Returns `{ ok, message }`; the message never contains a secret value.
 * `renameFile` exists so tests can inject a failing rename.
 */
export async function ensureEnvSecret({ envPath, key, renameFile = rename }) {
  if (!KEY_NAME_PATTERN.test(key)) throw new TypeError("Invalid secret key name.");
  const exact = `${key}=`;
  const loose = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);

  let stat;
  try {
    stat = await lstat(envPath);
  } catch (error) {
    if (error.code !== "ENOENT") return { ok: false, message: `Error accessing .env: ${error.code ?? error.message}` };
    try {
      await writePrivate(envPath, `${exact}${randomBytes(32).toString("hex")}\n`, renameFile);
    } catch (writeError) {
      return { ok: false, message: `Failed to create .env: ${writeError.code ?? writeError.message}` };
    }
    return { ok: true, message: `Created .env with ${key}.` };
  }

  if (stat.isSymbolicLink()) return { ok: false, message: ".env is a symlink - refusing to modify it." };
  if (!stat.isFile()) return { ok: false, message: ".env is not a regular file - refusing to modify it." };

  let contents;
  try {
    contents = await readExisting(envPath);
  } catch (error) {
    return { ok: false, message: `Failed to read .env: ${error.code ?? error.message}` };
  }

  const lines = contents.split("\n");
  const matches = [];
  for (const [index, original] of lines.entries()) {
    const line = original.endsWith("\r") ? original.slice(0, -1) : original;
    if (line.startsWith(exact)) matches.push({ index, value: line.slice(exact.length) });
    else if (loose.test(line)) return { ok: false, message: `${key} is written in an unsupported form. Use ${key}=<value> on its own line and re-run.` };
  }

  if (matches.length > 1) return { ok: false, message: `${key} appears more than once. Remove the duplicate entries manually and re-run.` };

  if (matches.length === 1) {
    const { index, value } = matches[0];
    if (value !== value.trim()) return { ok: false, message: `${key} has surrounding whitespace. Remove it manually and re-run.` };
    if (SECRET_PATTERN.test(value)) return { ok: true, message: `${key} is already set; no changes made.` };
    if (value) return { ok: false, message: `${key} exists but is not a valid 64-character lowercase hex string. Remove it manually and re-run.` };

    const ending = lines[index].endsWith("\r") ? "\r" : "";
    lines[index] = `${exact}${randomBytes(32).toString("hex")}${ending}`;
    try {
      await writePrivate(envPath, lines.join("\n"), renameFile);
    } catch (error) {
      return { ok: false, message: `Failed to write .env: ${error.code ?? error.message}` };
    }
    return { ok: true, message: `${key} has been generated and written to .env.` };
  }

  const eol = detectEol(contents);
  const prefix = contents && !contents.endsWith("\n") ? eol : "";
  try {
    await writePrivate(envPath, `${contents}${prefix}${exact}${randomBytes(32).toString("hex")}${eol}`, renameFile);
  } catch (error) {
    return { ok: false, message: `Failed to write .env: ${error.code ?? error.message}` };
  }
  return { ok: true, message: `${key} has been generated and written to .env.` };
}

/** Print the result and set a non-zero exit code on failure. */
export function reportEnvSecretResult(result) {
  if (result.ok) {
    console.log(result.message);
  } else {
    console.error(result.message);
    process.exitCode = 1;
  }
}
