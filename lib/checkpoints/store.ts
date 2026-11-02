import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { checkpoints } from "../../db/schema";
import type { DesktopPort } from "../agent/desktop-port";
import { createBlobStore, sha256, type BlobStore } from "../artifacts/blob-store";
import type { CheckpointEntry } from "../desktop/client";
import { canonicalJson } from "../receipts/chain.mjs";
import { captureState, parseState, type CheckpointState, type LoopSnapshot } from "./state";

type Database = Awaited<ReturnType<typeof getDatabase>>;

export const CAPTURE_TIMEOUT_MS = 10_000;
export type CheckpointStatus = "complete" | "partial";

// What the step loop hands to a checkpoint recorder. Tests inject a fake; production is createCheckpointRecorder.
export interface CheckpointSink {
  // idx 0 is the state before the first step; idx N is the state after receipt N. Never throws for file problems (those make the
  // checkpoint `partial`); throws only when nothing at all could be stored.
  capture(idx: number, snapshot: LoopSnapshot): Promise<void>;
}

const KNOWN_REASONS = new Set(["content_changed", "too_many_files", "scan_limit", "capture_timeout", "files_unsupported"]);
const reasonOf = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code ?? (error as Error | null)?.message;
  return typeof code === "string" && KNOWN_REASONS.has(code) ? code : "files_unreadable";
};

export function createCheckpointRecorder(options: {
  database: Database; ownerId: string; runId: string; desktop: DesktopPort; blobs?: BlobStore; timeoutMs?: number;
}): CheckpointSink {
  const { database, ownerId, runId, desktop } = options;
  const blobs = options.blobs ?? createBlobStore();
  const timeoutMs = options.timeoutMs ?? CAPTURE_TIMEOUT_MS;

  // One pass over the agent's files: list them, fetch only contents the store does not have yet, check every body against its hash.
  async function storeFiles(): Promise<{ manifestHash: string; fileCount: number; restorableCount: number }> {
    if (!desktop.checkpointManifest || !desktop.checkpointBlob) throw Object.assign(new Error("files_unsupported"), { code: "files_unsupported" });
    const manifest = await desktop.checkpointManifest();
    const seen = new Set<string>();
    for (const entry of manifest.entries) {
      if (!entry.sha256 || seen.has(entry.sha256)) continue;
      seen.add(entry.sha256);
      if (await blobs.has(entry.sha256)) continue;
      const bytes = await desktop.checkpointBlob({ area: entry.area, path: entry.path, sha256: entry.sha256 });
      if (sha256(bytes) !== entry.sha256 || (await blobs.put(bytes)) !== entry.sha256) throw Object.assign(new Error("content_changed"), { code: "content_changed" });
    }
    const entries = [...manifest.entries].sort((a, b) => (a.area + "/" + a.path < b.area + "/" + b.path ? -1 : 1));
    const text = canonicalJson({ v: 1, entries, skipped: manifest.skipped });
    return {
      manifestHash: await blobs.put(Buffer.from(text, "utf8")), fileCount: entries.length,
      restorableCount: entries.filter((entry) => entry.restorable).length,
    };
  }

  async function bounded<T>(work: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("capture_timeout"), { code: "capture_timeout" })), timeoutMs);
    });
    try { return await Promise.race([work(), deadline]); } finally { clearTimeout(timer); }
  }

  return {
    async capture(idx, snapshot) {
      const { text } = captureState(snapshot);
      const stateHash = await blobs.put(Buffer.from(text, "utf8"));

      // One retry covers transient problems such as a file being written while it was scanned. The whole capture, retry
      // included, is bounded by `timeoutMs`.
      type Outcome = { files: Awaited<ReturnType<typeof storeFiles>> } | { reason: string };
      const outcome: Outcome = await bounded<Outcome>(async () => {
        let reason = "files_unreadable";
        for (let attempt = 0; attempt < 2; attempt++) {
          try { return { files: await storeFiles() }; }
          catch (error) { reason = reasonOf(error); if (reason === "too_many_files" || reason === "files_unsupported") break; }
        }
        return { reason };
      }).catch((error) => ({ reason: reasonOf(error) }));
      const files = "files" in outcome ? outcome.files : null;
      await database.insert(checkpoints).values({
        id: randomUUID(), ownerId, runId, idx, stateHash, manifestHash: files?.manifestHash ?? null,
        fileCount: files?.fileCount ?? 0, restorableCount: files?.restorableCount ?? 0,
        status: files ? "complete" : "partial", reason: "reason" in outcome ? outcome.reason : null,
      });
    },
  };
}

export interface LoadedCheckpoint {
  idx: number;
  status: CheckpointStatus;
  reason: string | null;
  state: CheckpointState | null;
  entries: CheckpointEntry[];
  // TASK-043: an empty manifest is only valid when its blob was actually found and parsed. A missing or altered state/manifest
  // must refuse a rewind rather than look like "no files".
  stateFound: boolean;
  manifestFound: boolean;
}

// Reads one checkpoint back (for rewind, TASK-043, and tests). A missing or altered blob makes the state or manifest null/empty,
// and a caller must treat that as "cannot restore".
export async function loadCheckpoint(database: Database, ownerId: string, runId: string, idx: number, blobs: BlobStore = createBlobStore()): Promise<LoadedCheckpoint | null> {
  const found = await database.select().from(checkpoints)
    .where(and(eq(checkpoints.runId, runId), eq(checkpoints.ownerId, ownerId), eq(checkpoints.idx, idx))).limit(1);
  const row = found[0];
  if (!row) return null;
  const stateBytes = await blobs.get(row.stateHash);
  const manifestBytes = row.manifestHash ? await blobs.get(row.manifestHash) : null;
  let entries: CheckpointEntry[] = [];
  let manifestFound = false;
  if (manifestBytes) {
    try {
      const parsed = JSON.parse(manifestBytes.toString("utf8")) as { entries?: unknown };
      // An empty manifest is valid only when it is really a parsed list; a corrupt blob is not "no files".
      if (parsed && Array.isArray(parsed.entries)) { entries = parsed.entries as CheckpointEntry[]; manifestFound = true; }
    } catch { /* treated as a missing manifest below */ }
  }
  return {
    idx: row.idx, status: row.status === "complete" ? "complete" : "partial", reason: row.reason,
    state: stateBytes ? parseState(stateBytes.toString("utf8")) : null, entries,
    stateFound: stateBytes !== null, manifestFound,
  };
}

export async function listCheckpointIndexes(database: Database, ownerId: string, runId: string): Promise<{ idx: number; status: CheckpointStatus; reason: string | null }[]> {
  const rows = await database.select({ idx: checkpoints.idx, status: checkpoints.status, reason: checkpoints.reason }).from(checkpoints)
    .where(and(eq(checkpoints.runId, runId), eq(checkpoints.ownerId, ownerId))).orderBy(asc(checkpoints.idx));
  return rows.map((row) => ({ idx: row.idx, status: row.status === "complete" ? "complete" : "partial", reason: row.reason }));
}
