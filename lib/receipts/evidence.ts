import "server-only";

import { randomUUID } from "node:crypto";

import type { getDatabase } from "../../db/client";
import { stepEvidence } from "../../db/schema";
import type { Screenshot } from "../agent/desktop-port";
import type { SamBox } from "../agent/verification";
import { createBlobStore, type BlobStore } from "../artifacts/blob-store";

type Database = Awaited<ReturnType<typeof getDatabase>>;

// TASK-031. What the step loop hands over after a receipt is written. The screenshots are the exact bytes whose SHA-256
// is in the signed receipt (`before_hash`, `after_hash`); the recorder stores them by that hash and links them to the step.
export interface EvidenceInput { idx: number; before: Screenshot | null; after: Screenshot | null; samBox: SamBox | null }
export interface EvidenceSink { record(input: EvidenceInput): Promise<void> }

export function createEvidenceRecorder(options: { database: Database; ownerId: string; runId: string; blobs?: BlobStore }): EvidenceSink {
  const { database, ownerId, runId } = options;
  const blobs = options.blobs ?? createBlobStore();
  const store = async (shot: Screenshot | null) => (shot ? blobs.put(Buffer.from(shot.base64, "base64")) : null);

  return {
    async record({ idx, before, after, samBox }) {
      // File steps have no screenshots; they get no evidence row.
      if (!before && !after) return;
      const beforeHash = await store(before);
      const afterHash = await store(after);
      const size = after ?? before;
      await database.insert(stepEvidence).values({
        id: randomUUID(), ownerId, runId, idx, beforeHash, afterHash,
        width: size?.width ?? null, height: size?.height ?? null, samBox: samBox ?? null,
      });
    },
  };
}
