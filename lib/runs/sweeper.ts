import "server-only";

import { and, desc, eq, isNotNull, isNull, lt } from "drizzle-orm";
import type { getDatabase } from "../../db/client";
import { approvals, checkpoints, runMeta, runs } from "../../db/schema";
import { refreshApprovalAttention } from "../approvals/attention";
import { expireApproval } from "../approvals/store";
import { appendAgentCard } from "../chat/data";
import { sealExisting } from "../receipts/store";
import type { ReceiptSigner } from "../receipts/signer";
import { recordAuditBestEffort } from "../security/audit";

type Database = Awaited<ReturnType<typeof getDatabase>>;
const STALE_MS = 3 * 60_000;
const MAX_PER_TICK = 20;

// TASK-085. Seals unsealed runs whose heartbeat is older than three minutes, expires their pending
// approvals and posts one honest interrupted card. Runs with no heartbeat (created before this change)
// are never touched. The sweep is bounded and always guarded by `signature IS NULL`.
export async function sweepStalledRuns(database: Database, signer: ReceiptSigner, now = new Date()): Promise<{ swept: number }> {
  if (process.env.RUN_SWEEPER_ENABLED === "false") return { swept: 0 };
  const cutoff = new Date(now.getTime() - STALE_MS);
  const stalled = await database.select({ id: runs.id, ownerId: runs.ownerId, agentId: runs.agentId }).from(runs)
    .where(and(isNull(runs.signature), isNotNull(runs.heartbeatAt), lt(runs.heartbeatAt, cutoff))).limit(MAX_PER_TICK);
  let swept = 0;
  for (const run of stalled) {
    const result = await sealExisting({ database, ownerId: run.ownerId, runId: run.id, signer, status: "interrupted", now });
    if (!result.sealed) continue;
    const pending = await database.select({ id: approvals.id }).from(approvals)
      .where(and(eq(approvals.ownerId, run.ownerId), eq(approvals.runId, run.id), eq(approvals.state, "pending")));
    for (const approval of pending) await expireApproval(database, run.ownerId, approval.id);
    await refreshApprovalAttention(database, run.ownerId, run.agentId).catch(() => undefined);
    const step = result.stepCount;
    // TASK-085. Continue opens the rewind dialog at the last checkpoint that was saved in full.
    const saved = await database.select({ idx: checkpoints.idx }).from(checkpoints)
      .where(and(eq(checkpoints.ownerId, run.ownerId), eq(checkpoints.runId, run.id), eq(checkpoints.status, "complete")))
      .orderBy(desc(checkpoints.idx)).limit(1);
    const lastCheckpoint = saved[0]?.idx ?? null;
    await appendAgentCard(database, run.ownerId, run.agentId, {
      card: {
        type: "message",
        text: `I stopped because the app restarted during step ${step}. Proof up to step ${step} is sealed.${lastCheckpoint === null ? " No complete checkpoint was saved, so this run cannot be continued." : ""}`,
        ...(lastCheckpoint === null ? {} : { continueRunId: run.id }),
      },
      sourceTag: "system", runId: run.id,
    });
    // TASK-076. A helper cannot outlive its parent: an interrupted parent seals its helpers interrupted too.
    const helpers = await database.select({ runId: runMeta.runId }).from(runMeta)
      .where(and(eq(runMeta.ownerId, run.ownerId), eq(runMeta.parentRunId, run.id)));
    for (const helper of helpers) {
      await sealExisting({ database, ownerId: run.ownerId, runId: helper.runId, signer, status: "interrupted", now }).catch(() => undefined);
    }
    await recordAuditBestEffort(database, run.ownerId, { kind: "run_interrupted", agentId: run.agentId, runId: run.id, code: "interrupted" });
    swept += 1;
  }
  return { swept };
}
