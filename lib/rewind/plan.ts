import type { CheckpointEntry } from "../desktop/client";

// TASK-043. Pure diff between a saved checkpoint manifest and the agent's live files. The app applies the plan through the
// desktop restore tool; this module only decides what to write back, what to move aside, and what to leave alone.
export const MAX_REWIND_OPERATIONS = 200;
export const MAX_REWIND_BYTES = 64 * 1024 * 1024;

export type RewindPlanRefusal = "checkpoint_incomplete" | "file_not_restorable" | "too_many_changes";
export interface RestorePut { area: CheckpointEntry["area"]; path: string; sha256: string; size: number }
export interface RestoreAside { area: CheckpointEntry["area"]; path: string }
export interface RewindPlan { put: RestorePut[]; aside: RestoreAside[]; kept: number; bytes: number }
export type PlanResult = { ok: true; plan: RewindPlan } | { ok: false; reason: RewindPlanRefusal };

const keyOf = (entry: { area: string; path: string }) => `${entry.area}/${entry.path}`;
const byPath = (a: { area: string; path: string }, b: { area: string; path: string }) =>
  keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0;

export function planRestore(
  saved: readonly CheckpointEntry[],
  current: readonly CheckpointEntry[],
  limits: { maxOperations?: number; maxBytes?: number } = {},
): PlanResult {
  const maxOperations = limits.maxOperations ?? MAX_REWIND_OPERATIONS;
  const maxBytes = limits.maxBytes ?? MAX_REWIND_BYTES;
  const savedByPath = new Map<string, CheckpointEntry>();
  for (const entry of saved) {
    const key = keyOf(entry);
    // Two different saved versions of one path would make the restore ambiguous.
    if (savedByPath.has(key)) return { ok: false, reason: "checkpoint_incomplete" };
    savedByPath.set(key, entry);
  }
  const currentByPath = new Map<string, CheckpointEntry>();
  for (const entry of current) currentByPath.set(keyOf(entry), entry);

  const put: RestorePut[] = [];
  const aside: RestoreAside[] = [];
  let kept = 0;
  let bytes = 0;

  for (const entry of savedByPath.values()) {
    const live = currentByPath.get(keyOf(entry));
    if (!entry.restorable) {
      // The checkpoint holds no bytes for this file, so it can only be kept as it is. A missing or resized file cannot be
      // brought back (the tool refuses files over 4 MiB).
      if (!live || live.size !== entry.size) return { ok: false, reason: "file_not_restorable" };
      kept += 1;
      continue;
    }
    if (!entry.sha256) return { ok: false, reason: "checkpoint_incomplete" };
    if (live && live.restorable && live.sha256 === entry.sha256) { kept += 1; continue; }
    put.push({ area: entry.area, path: entry.path, sha256: entry.sha256, size: entry.size });
    bytes += entry.size;
  }

  for (const [key, entry] of currentByPath) {
    if (!savedByPath.has(key)) aside.push({ area: entry.area, path: entry.path });
  }

  if (put.length + aside.length > maxOperations || bytes > maxBytes) return { ok: false, reason: "too_many_changes" };
  put.sort(byPath);
  aside.sort(byPath);
  return { ok: true, plan: { put, aside, kept, bytes } };
}
