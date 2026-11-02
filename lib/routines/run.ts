import "server-only";

import { and, desc, eq } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { runMeta } from "../../db/schema";
import type { RunOutcome } from "../agent/step-loop";
import { CHAT_RUN_TEXT, createChatRunPorts, prepareChatRun, type ChatRunPorts } from "../agent/chat-run";
import { registerRun } from "../jobs/control";
import { routineOutcomeDisposition, routineTaskText } from "./execution-plan";
import type { RoutineJob } from "./queue";
import type { RoutineRecord } from "./schema";

type Database = Awaited<ReturnType<typeof getDatabase>>;

export interface RoutineRunResult {
  outcome: RunOutcome | null;
  runId: string | null;
  retry: boolean;
  reason?: "no_model" | "unavailable" | "no_signing_key" | "failed";
}

export async function runRoutineExecution(
  database: Database,
  job: RoutineJob,
  routine: RoutineRecord,
  retryCount: number,
  ports: ChatRunPorts = createChatRunPorts(database),
): Promise<RoutineRunResult> {
  const task = routineTaskText(routine.goal, routine.steps);
  let queueRetryOf: string | undefined;
  if (retryCount > 0) {
    const rows = await database.select({ runId: runMeta.runId }).from(runMeta).where(and(
      eq(runMeta.ownerId, job.ownerId),
      eq(runMeta.routineId, job.routineId),
      eq(runMeta.executionId, job.executionId),
    )).orderBy(desc(runMeta.createdAt)).limit(1);
    queueRetryOf = rows[0]?.runId;
  }
  // A queue retry points at the previous attempt; the first attempt of a manual retry points at the original run.
  const retryOf = queueRetryOf ?? job.retryOf;

  const prepared = await prepareChatRun(ports, job.ownerId, job.agentId, task, {
    meta: {
      trigger: job.trigger,
      routineId: job.routineId,
      executionId: job.executionId,
      label: routine.goal,
      ...(retryOf ? { retryOf } : {}),
    },
  });
  if (!prepared.ok) {
    if (prepared.reason === "unavailable") return { outcome: null, runId: null, retry: true, reason: prepared.reason };
    try { await ports.postCard(job.ownerId, job.agentId, { type: "message", text: CHAT_RUN_TEXT[prepared.reason] }); } catch { /* fixed card only */ }
    return { outcome: null, runId: null, retry: false, reason: prepared.reason };
  }

  const { start, receipts, costs, provider, samConfig } = prepared;
  const control = receipts?.runId ? registerRun(receipts.runId, job.ownerId, job.agentId) : null;
  try {
    const result = await ports.run({
      receipts, costs, evidence: start.evidence?.(), checkpoints: start.checkpoints?.(),
      agent: start.persona, task, provider, model: start.model, hardModel: start.hardModel, samConfig, desktop: start.desktop,
      skills: start.skills, timezone: start.timezone, ...(control ? { signal: control.signal } : {}),
      canary: start.canary, approvals: start.approvals, allowedHosts: start.allowedHosts, onScopeBlocked: start.onScopeBlocked,
      onSecurityStop: start.onSecurityStop
        ? (event) => start.onSecurityStop!({ ...event, runId: receipts?.runId })
        : undefined,
      postCard: (card) => ports.postCard(job.ownerId, job.agentId, card, receipts?.runId),
      onFileDelivered: ports.fileDelivered
        ? (file) => ports.fileDelivered!(job.ownerId, job.agentId, file, receipts?.runId)
        : undefined,
    });
    return {
      outcome: result.outcome,
      runId: receipts?.runId ?? null,
      retry: routineOutcomeDisposition(result.outcome) === "retry",
    };
  } catch {
    return { outcome: null, runId: receipts?.runId ?? null, retry: true, reason: "failed" };
  } finally {
    control?.done();
  }
}
