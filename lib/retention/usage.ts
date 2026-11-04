import "server-only";

import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import { artifactsRoot } from "../artifacts/blob-store";

// Instance-wide artifact cap. Receipts and audit rows are append-only and live
// in Postgres (not counted here); this covers the heavy bytes in `artifacts`
// that the 32-day sweep thins out: blobs/, teach/, skills/, checkpoints files.
export function artifactsCapBytes(): number {
  const raw = Number(process.env.ARTIFACTS_CAP_BYTES);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 20_000_000_000;
}

async function dirBytes(directory: string, budget: { files: number }): Promise<number> {
  let total = 0;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (budget.files <= 0) break;
    const full = path.join(directory, name);
    let info;
    try {
      info = await lstat(full);
    } catch {
      continue;
    }
    budget.files -= 1;
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) total += await dirBytes(full, budget);
    else if (info.isFile()) total += info.size;
  }
  return total;
}

export interface StorageUsage {
  bytes: number;
  capBytes: number;
  /** 0–1+ fraction of the cap. */
  fraction: number;
}

export async function measureArtifacts(): Promise<StorageUsage> {
  const capBytes = artifactsCapBytes();
  const bytes = await dirBytes(artifactsRoot(), { files: 200_000 });
  return { bytes, capBytes, fraction: capBytes > 0 ? bytes / capBytes : 0 };
}
