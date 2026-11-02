import { z } from "zod";

import { getDatabase } from "@/db/client";
import {
  readBoundedJson,
  requestErrorResponse,
  requireNoQuery,
  requireOwnerRequest,
  RequestError,
} from "@/lib/auth/request";
import { RoutineExecutionError, startRoutineNow } from "@/lib/routines/execution";
import { checkRoutineRunRateLimit } from "@/lib/routines/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const paramsSchema = z.object({ routineId: z.string().uuid() }).strict();
const bodySchema = z.object({}).strict();

function executionErrorResponse(error: unknown): Response {
  const headers = new Headers(NO_STORE);
  if (error instanceof RoutineExecutionError) {
    if (error.code === "routine_not_found") {
      return Response.json({ error: "routine_not_found" }, { status: 404, headers });
    }
    return Response.json({ error: "queue_unavailable" }, { status: 503, headers });
  }
  const response = requestErrorResponse(error);
  for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
  return response;
}

export async function POST(request: Request, { params }: { params: Promise<{ routineId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const rate = checkRoutineRunRateLimit();
    if (!rate.allowed) {
      return Response.json({ error: "rate_limited", retryAfter: rate.retryAfter },
        { status: 429, headers: { ...NO_STORE, "Retry-After": String(rate.retryAfter) } });
    }
    const parsedParams = paramsSchema.safeParse(await params);
    if (!parsedParams.success) throw new RequestError(400, "invalid_routine");
    const body = bodySchema.safeParse(await readBoundedJson(request, 4 * 1024));
    if (!body.success) throw new RequestError(400, "invalid_input");
    const executionId = await startRoutineNow(await getDatabase(), session.ownerId, parsedParams.data.routineId);
    return Response.json({ executionId, status: "queued" }, { status: 202, headers: NO_STORE });
  } catch (error) {
    return executionErrorResponse(error);
  }
}
