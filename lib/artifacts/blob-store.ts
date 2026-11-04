import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

// TASK-031/032. Content-addressed files in the `artifacts` volume: `<root>/blobs/ab/<64 hex>`. The name is the SHA-256 of
// the bytes, so a screenshot or checkpoint file can be matched to the hash in a signed receipt or a manifest. Only this
// module touches the directory, and it only ever builds paths from a validated 64-character hex hash.
export const HASH_PATTERN = /^[0-9a-f]{64}$/;
// A screenshot is at most about 1 MB and a checkpointed file at most 4 MiB; anything larger is a bug or an attack.
export const MAX_BLOB_BYTES = 8 * 1024 * 1024;

export interface BlobStore {
  has(hash: string): Promise<boolean>;
  // Like `has`, and also marks an existing blob as just used. Retention deletes by age, so every reuse of a stored blob
  // (an unchanged checkpoint file, a repeated screenshot) goes through `touch` or `put` and refreshes it.
  touch?(hash: string): Promise<boolean>;
  put(bytes: Uint8Array): Promise<string>;
  // null when the blob is missing, too large, not a plain file or no longer matches its name.
  get(hash: string): Promise<Buffer | null>;
}

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function artifactsRoot(): string {
  const configured = process.env.ARTIFACTS_DIR;
  const root = configured && path.isAbsolute(configured) ? configured : "/var/eclipse/artifacts";
  return path.resolve(root);
}

export function createBlobStore(root: string = artifactsRoot()): BlobStore {
  const blobs = path.join(root, "blobs");
  const locate = (hash: string) => {
    if (!HASH_PATTERN.test(hash)) throw new Error("invalid_hash");
    return path.join(blobs, hash.slice(0, 2), hash);
  };
  const plainFile = async (file: string) => {
    try { const info = await lstat(file); return info.isFile() && !info.isSymbolicLink() ? info : null; } catch { return null; }
  };
  // Best effort: a failed timestamp update never fails the caller (the retention keep-set is the second guard).
  const refresh = async (file: string) => {
    const now = new Date();
    await utimes(file, now, now).catch(() => undefined);
  };

  return {
    async has(hash) {
      return (await plainFile(locate(hash))) !== null;
    },
    async touch(hash) {
      const file = locate(hash);
      if (!(await plainFile(file))) return false;
      await refresh(file);
      return true;
    },
    async put(bytes) {
      if (bytes.length > MAX_BLOB_BYTES) throw new Error("blob_too_large");
      const hash = sha256(bytes);
      const file = locate(hash);
      if (await plainFile(file)) { await refresh(file); return hash; }
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = path.join(path.dirname(file), `.${randomBytes(12).toString("hex")}.part`);
      try {
        await writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
        await rename(temp, file);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
      return hash;
    },
    async get(hash) {
      if (!HASH_PATTERN.test(hash)) return null;
      const file = locate(hash);
      const info = await plainFile(file);
      if (!info || info.size > MAX_BLOB_BYTES) return null;
      let bytes: Buffer;
      try { bytes = await readFile(file); } catch { return null; }
      return sha256(bytes) === hash ? bytes : null;
    },
  };
}
