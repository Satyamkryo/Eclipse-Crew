import "server-only";

import { and, eq, gt } from "drizzle-orm";
import { lstat, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { getDatabase } from "../../db/client";
import { checkpoints, stepEvidence, teachRecordings } from "../../db/schema";
import { artifactsRoot, createBlobStore, HASH_PATTERN } from "../artifacts/blob-store";

type Database = Awaited<ReturnType<typeof getDatabase>>;

// Evidence blobs (step screenshots, checkpoint states/manifests/file contents)
// live at most this long. Receipt text, audit rows and run rows are append-only
// and stay forever; only the heavy bytes are thinned. Anyone who wants a copy
// downloads it (per-step Download, run Export) before the sweep.
export const EVIDENCE_RETENTION_DAYS = 32;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_BLOB_DELETES_PER_TICK = 500;
const MAX_TEACH_DELETES_PER_TICK = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTIVE_TEACH_STATES = new Set(["recording", "paused", "finalizing"]);

async function walkFiles(directory: string, out: string[]): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  for (const name of names) {
    const full = path.join(directory, name);
    let info;
    try {
      info = await lstat(full);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) await walkFiles(full, out);
    else if (info.isFile()) out.push(full);
  }
}

function manifestEntryHashes(manifestBytes: Buffer, into: Set<string>): void {
  let parsed: { entries?: unknown };
  try {
    parsed = JSON.parse(manifestBytes.toString("utf8")) as { entries?: unknown };
  } catch {
    return;
  }
  if (!parsed || !Array.isArray(parsed.entries)) return;
  for (const entry of parsed.entries) {
    if (entry && typeof entry === "object" && typeof (entry as { sha256?: unknown }).sha256 === "string") {
      const hash = (entry as { sha256: string }).sha256;
      if (HASH_PATTERN.test(hash)) into.add(hash);
    }
  }
}

export interface RetentionSweep {
  blobsDeleted: number;
  bytesFreed: number;
  teachDeleted: number;
}

/**
 * Delete evidence bytes older than `keepDays` that no recent run references.
 * Referenced = step screenshots and checkpoint state/manifest/file blobs of
 * runs with rows newer than the cutoff. Receipts, run rows and audit rows
 * are untouched, so proof still verifies; only images/rewind data thins out.
 */
export async function sweepOldEvidence(
  database: Database, now = new Date(), keepDays = EVIDENCE_RETENTION_DAYS,
): Promise<RetentionSweep> {
  const result: RetentionSweep = { blobsDeleted: 0, bytesFreed: 0, teachDeleted: 0 };
  const cutoff = new Date(now.getTime() - keepDays * MS_PER_DAY);
  const blobs = createBlobStore();

  const keep = new Set<string>();
  const evidence = await database.select({ beforeHash: stepEvidence.beforeHash, afterHash: stepEvidence.afterHash })
    .from(stepEvidence).where(gt(stepEvidence.createdAt, cutoff));
  for (const row of evidence) {
    if (row.beforeHash && HASH_PATTERN.test(row.beforeHash)) keep.add(row.beforeHash);
    if (row.afterHash && HASH_PATTERN.test(row.afterHash)) keep.add(row.afterHash);
  }
  // Every recent checkpoint is read (no row cap): a capped, unordered subset would leave newer checkpoints' unchanged
  // files unprotected.
  const points = await database.select({
    stateHash: checkpoints.stateHash, manifestHash: checkpoints.manifestHash,
  }).from(checkpoints).where(gt(checkpoints.createdAt, cutoff));
  for (const row of points) {
    if (HASH_PATTERN.test(row.stateHash)) keep.add(row.stateHash);
    if (row.manifestHash && HASH_PATTERN.test(row.manifestHash)) {
      keep.add(row.manifestHash);
      const bytes = await blobs.get(row.manifestHash).catch(() => null);
      if (bytes) manifestEntryHashes(bytes, keep);
    }
  }

  const blobRoot = path.join(artifactsRoot(), "blobs");
  const files: string[] = [];
  await walkFiles(blobRoot, files);
  for (const file of files) {
    if (result.blobsDeleted >= MAX_BLOB_DELETES_PER_TICK) break;
    const hash = path.basename(file);
    if (!HASH_PATTERN.test(hash)) continue;
    if (keep.has(hash)) continue;
    let info;
    try {
      info = await stat(file);
    } catch {
      continue;
    }
    if (info.mtime.getTime() >= cutoff.getTime()) continue;
    // A run may have reused this blob (put/touch refresh its time) while the walk was running: re-check just before rm.
    try {
      if ((await stat(file)).mtime.getTime() >= cutoff.getTime()) continue;
    } catch {
      continue;
    }
    try {
      await rm(file, { force: true });
      result.blobsDeleted += 1;
      result.bytesFreed += info.size;
    } catch {
      // A later tick retries.
    }
  }

  // Teach capture namespaces older than the window, unless still active.
  // Approved skills keep their own reference copies under skills/.
  const teachRoot = path.join(artifactsRoot(), "teach");
  let owners: string[];
  try {
    owners = await readdir(teachRoot);
  } catch {
    return result;
  }
  for (const owner of owners) {
    if (result.teachDeleted >= MAX_TEACH_DELETES_PER_TICK) break;
    // Only owner-id folders are ours; anything else is left alone (and would make the uuid query throw).
    if (!UUID_PATTERN.test(owner)) continue;
    const ownerDir = path.join(teachRoot, owner);
    let captures: string[];
    try {
      captures = await readdir(ownerDir);
    } catch {
      continue;
    }
    for (const capture of captures) {
      if (result.teachDeleted >= MAX_TEACH_DELETES_PER_TICK) break;
      if (!UUID_PATTERN.test(capture)) continue;
      const full = path.join(ownerDir, capture);
      let info;
      try {
        info = await lstat(full);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
      } catch {
        continue;
      }
      if (info.mtime.getTime() >= cutoff.getTime()) continue;
      const rows = await database.select({ state: teachRecordings.state }).from(teachRecordings)
        .where(and(eq(teachRecordings.ownerId, owner), eq(teachRecordings.id, capture))).limit(1);
      if (rows[0] && ACTIVE_TEACH_STATES.has(rows[0].state)) continue;
      try {
        await rm(full, { recursive: true, force: true });
        result.teachDeleted += 1;
      } catch {
        // A later tick retries.
      }
    }
  }
  return result;
}
