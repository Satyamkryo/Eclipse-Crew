import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import type { getDatabase } from "../../db/client";
import { runs } from "../../db/schema";

type Database = Awaited<ReturnType<typeof getDatabase>>;

// TASK-085. Updates heartbeat_at every 15 s. A missing row means the sweeper already sealed the run;
// the callback stops the live loop without posting a second card. A database error never stops a run.
export function startHeartbeat(
  database: Database, ownerId: string, runId: string,
  { onCancel, onSealed, intervalMs = 15_000 }: { onCancel: () => void; onSealed: () => void; intervalMs?: number },
): () => void {
  let stopped = false; let timer: ReturnType<typeof setTimeout> | undefined;
  const beat = async () => {
    if (stopped) return;
    try {
      const rows = await database.update(runs).set({ heartbeatAt: new Date() })
        .where(and(eq(runs.id, runId), eq(runs.ownerId, ownerId), isNull(runs.signature)))
        .returning({ cancel: runs.cancelRequestedAt });
      if (!rows[0]) { stopped = true; onSealed(); return; }
      if (rows[0].cancel) onCancel();
    } catch { /* a database error never stops a run */ }
    finally { if (!stopped) { timer = setTimeout(beat, intervalMs); timer.unref?.(); } }
  };
  void beat();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
