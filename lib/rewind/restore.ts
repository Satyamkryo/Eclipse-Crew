import "server-only";

import type { BlobStore } from "../artifacts/blob-store";
import type { DesktopPort } from "../agent/desktop-port";
import type { RewindPlan } from "./plan";

// TASK-043. Applies a rewind plan through the desktop's agent-user restore tool. A failure leaves the restored counts so the
// owner is told the truth; a second identical request recomputes the plan and finishes the work.
export type RestoreFailure = "blob_missing" | "restore_failed" | "files_unsupported";
export interface RestoredCounts { put: number; aside: number }

export class RestoreError extends Error {
  constructor(public code: RestoreFailure, public restored: RestoredCounts, public causeCode: string | null = null) {
    super(code);
  }
}

const safeCodeOf = (error: unknown): string | null => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : null;
};

// A needed blob must exist and still re-hash to its name. Checked before any file is touched.
export async function preflightBlobs(blobs: BlobStore, plan: RewindPlan): Promise<"blob_missing" | null> {
  const seen = new Set<string>();
  for (const operation of plan.put) {
    if (seen.has(operation.sha256)) continue;
    seen.add(operation.sha256);
    if (!(await blobs.get(operation.sha256))) return "blob_missing";
  }
  return null;
}

export async function applyRestore(
  desktop: DesktopPort, blobs: BlobStore, plan: RewindPlan, bucket: string,
): Promise<RestoredCounts> {
  if (!desktop.checkpointPut || !desktop.checkpointAside) throw new RestoreError("files_unsupported", { put: 0, aside: 0 });
  const restored: RestoredCounts = { put: 0, aside: 0 };
  const cache = new Map<string, Buffer>();
  try {
    // Writes first, then moves: a put can create a directory an aside would otherwise create first.
    for (const operation of plan.put) {
      let bytes = cache.get(operation.sha256);
      if (!bytes) {
        const value = await blobs.get(operation.sha256);
        if (!value) throw Object.assign(new Error("blob_missing"), { code: "blob_missing" });
        bytes = value;
        cache.set(operation.sha256, value);
      }
      await desktop.checkpointPut({ area: operation.area, path: operation.path, sha256: operation.sha256, size: operation.size }, bytes);
      restored.put += 1;
    }
    for (const operation of plan.aside) {
      await desktop.checkpointAside({ ...operation, bucket });
      restored.aside += 1;
    }
    return restored;
  } catch (error) {
    if (error instanceof RestoreError) throw error;
    const cause = safeCodeOf(error);
    throw new RestoreError(cause === "blob_missing" ? "blob_missing" : "restore_failed", restored, cause);
  }
}
