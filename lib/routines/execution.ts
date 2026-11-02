import "server-only";

import { and, desc, eq } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { routines, runMeta } from "../../db/schema";
import { loadRunDetail } from "../receipts/history";
import { executionView, type RoutineExecutionView } from "./execution-view";
import { enqueueRoutineJob, manualRoutineExecutionId, routineJobState } from "./queue";

type Database = Awaited<ReturnType<typeof getDatabase>>;

export class RoutineExecutionError extends Error {
  constructor(public code: "routine_not_found" | "execution_not_found" | "queue_unavailable") {
    super(code);
    this.name = "RoutineExecutionError";
  }
}

async function ownedRoutine(database: Database, ownerId: string, routineId: string) {
  const [row] = await database.select({ id: routines.id, agentId: routines.agentId }).from(routines)
    .where(and(eq(routines.ownerId, ownerId), eq(routines.id, routineId))).limit(1);
  if (!row) throw new RoutineExecutionError("routine_not_found");
  return row;
}

export async function startRoutineNow(
  database: Database, ownerId: string, routineId: string, options: { retryOf?: string } = {},
): Promise<string> {
  const routine = await ownedRoutine(database, ownerId, routineId);
  const executionId = manualRoutineExecutionId();
  try {
    await database.transaction(async (tx) => {
      await enqueueRoutineJob(tx, {
        ownerId,
        routineId,
        agentId: routine.agentId,
        executionId,
        trigger: "run_now",
        ...(options.retryOf ? { retryOf: options.retryOf } : {}),
      });
    });
  } catch {
    throw new RoutineExecutionError("queue_unavailable");
  }
  return executionId;
}

export async function readRoutineExecution(
  database: Database, ownerId: string, routineId: string, executionId: string,
): Promise<RoutineExecutionView> {
  await ownedRoutine(database, ownerId, routineId);
  const job = await routineJobState(executionId, { ownerId, routineId });
  const [meta] = await database.select({ runId: runMeta.runId }).from(runMeta).where(and(
    eq(runMeta.ownerId, ownerId),
    eq(runMeta.routineId, routineId),
    eq(runMeta.executionId, executionId),
  )).orderBy(desc(runMeta.createdAt)).limit(1);
  const detail = meta ? await loadRunDetail(database, ownerId, meta.runId) : null;
  const view = executionView(executionId, job, detail);
  if (!view) throw new RoutineExecutionError("execution_not_found");
  return view;
}
