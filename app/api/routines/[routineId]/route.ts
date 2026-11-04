import { z } from "zod";
import { getDatabase } from "@/db/client";
import { requireNoQuery, requireOwnerRequest, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { deleteRoutine, RoutineError } from "@/lib/routines/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

// Owner-scoped routine delete. Past runs (receipts) stay; only the schedule is removed.
export async function DELETE(request: Request, { params }: { params: Promise<{ routineId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const parsedParams = z.object({ routineId: z.string().uuid() }).strict().safeParse(await params);
    if (!parsedParams.success) throw new RequestError(400, "invalid_routine");
    const deleted = await deleteRoutine(await getDatabase(), session.ownerId, parsedParams.data.routineId);
    return Response.json({ deleted }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof RoutineError) {
      const status = error.code === "routine_not_found" ? 404 : 400;
      return Response.json({ error: error.code }, { status, headers: NO_STORE });
    }
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
