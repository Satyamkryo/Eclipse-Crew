import { z } from "zod";
import { getDatabase } from "@/db/client";
import { readBoundedJson, requestErrorResponse, requireNoQuery, requireOwnerRequest, RequestError } from "@/lib/auth/request";
import { RoutineError, setRoutineActive } from "@/lib/routines/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const bodySchema = z.object({ active: z.boolean() }).strict();

// TASK-042. Pause or resume a routine from the Jobs page. Resume recomputes the next run from now.
export async function POST(request: Request, { params }: { params: Promise<{ routineId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const parsedParams = z.object({ routineId: z.string().uuid() }).strict().safeParse(await params);
    if (!parsedParams.success) throw new RequestError(400, "invalid_routine");
    const body = bodySchema.safeParse(await readBoundedJson(request, 1024));
    if (!body.success) throw new RequestError(400, "invalid_input");
    const routine = await setRoutineActive(await getDatabase(), session.ownerId, parsedParams.data.routineId, body.data.active);
    return Response.json({ routine }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof RoutineError) {
      const status = error.code === "routine_not_found" ? 404 : error.code === "once_expired" ? 409 : 400;
      return Response.json({ error: error.code }, { status, headers: NO_STORE });
    }
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
