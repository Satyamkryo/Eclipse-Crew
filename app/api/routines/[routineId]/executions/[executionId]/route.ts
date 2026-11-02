import { z } from "zod";

import { getDatabase } from "@/db/client";
import {
  requestErrorResponse,
  requireNoQuery,
  requireOwnerRequest,
  RequestError,
} from "@/lib/auth/request";
import { readRoutineExecution, RoutineExecutionError } from "@/lib/routines/execution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const paramsSchema = z.object({
  routineId: z.string().uuid(),
  executionId: z.string().uuid(),
}).strict();

function executionErrorResponse(error: unknown): Response {
  const headers = new Headers(NO_STORE);
  if (error instanceof RoutineExecutionError) {
    return Response.json({ error: error.code }, { status: error.code === "queue_unavailable" ? 503 : 404, headers });
  }
  const response = requestErrorResponse(error);
  for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
  return response;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ routineId: string; executionId: string }> },
) {
  try {
    const session = await requireOwnerRequest(request);
    requireNoQuery(request);
    const parsed = paramsSchema.safeParse(await params);
    if (!parsed.success) throw new RequestError(400, "invalid_execution");
    const execution = await readRoutineExecution(
      await getDatabase(), session.ownerId, parsed.data.routineId, parsed.data.executionId,
    );
    return Response.json(execution, { headers: NO_STORE });
  } catch (error) {
    return executionErrorResponse(error);
  }
}
