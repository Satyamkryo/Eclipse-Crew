import { z } from "zod";
import { getDatabase } from "@/db/client";
import { startChatRun } from "@/lib/agent/chat-run";
import { isAgentBusy } from "@/lib/agent/step-loop";
import { requestErrorResponse, requireNoQuery, requireOwnerRequest, RequestError } from "@/lib/auth/request";
import { hasNewerAttempt, loadRunForAction } from "@/lib/jobs/data";
import { RoutineExecutionError, startRoutineNow } from "@/lib/routines/execution";
import { checkRoutineRunRateLimit } from "@/lib/routines/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

function denied(code: string, status = 409) {
  return Response.json({ error: code }, { status, headers: NO_STORE });
}

// TASK-042. Retry a sealed chat run, or a routine run through the routine queue. The task/routine comes from the
// stored run, never from the client.
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const parsed = z.object({ runId: z.string().uuid() }).strict().safeParse(await params);
    if (!parsed.success) throw new RequestError(400, "invalid_run");
    const database = await getDatabase();
    const run = await loadRunForAction(database, session.ownerId, parsed.data.runId);
    if (!run) return denied("run_not_found", 404);
    if (!run.sealed) return denied("not_retryable");
    if (run.summary.outcome === "verified") return denied("already_verified");
    if (run.summary.outcome === "running") return denied("running");
    const routineRun = run.trigger === "schedule" || run.trigger === "run_now";
    // Replays never store their typed text; branches and heals are deliberate corrections, not retries.
    if (run.trigger !== "chat" && !routineRun) return denied("not_retryable");
    if (routineRun && !run.routineId) return denied("not_retryable");
    if (await hasNewerAttempt(database, session.ownerId, parsed.data.runId)) return denied("already_retried");
    if (isAgentBusy(run.summary.agentId)) return denied("agent_busy");

    if (run.trigger === "chat") {
      if (!run.task.trim()) return denied("not_retryable");
      startChatRun(database, session.ownerId, run.summary.agentId, run.task, {
        trigger: "chat", retryOf: parsed.data.runId, label: run.summary.label,
      });
      return Response.json({ started: true }, { status: 202, headers: NO_STORE });
    }

    const routineId = run.routineId;
    if (!routineId) return denied("not_retryable");
    const rate = checkRoutineRunRateLimit();
    if (!rate.allowed) {
      return Response.json({ error: "rate_limited", retryAfter: rate.retryAfter },
        { status: 429, headers: { ...NO_STORE, "Retry-After": String(rate.retryAfter) } });
    }
    try {
      const executionId = await startRoutineNow(database, session.ownerId, routineId, { retryOf: parsed.data.runId });
      return Response.json({ started: true, executionId }, { status: 202, headers: NO_STORE });
    } catch (error) {
      if (error instanceof RoutineExecutionError) {
        return error.code === "routine_not_found" ? denied("not_retryable") : denied("queue_unavailable", 503);
      }
      throw error;
    }
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
