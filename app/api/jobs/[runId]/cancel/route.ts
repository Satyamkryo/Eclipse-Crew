import { z } from "zod";
import { getDatabase } from "@/db/client";
import { requestErrorResponse, requireNoQuery, requireOwnerRequest, RequestError } from "@/lib/auth/request";
import { cancelRun } from "@/lib/jobs/control";
import { loadRunForAction } from "@/lib/jobs/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

// TASK-042. Only a run still held by this server process can be cancelled; a run left over from a restart is "not running".
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const parsed = z.object({ runId: z.string().uuid() }).strict().safeParse(await params);
    if (!parsed.success) throw new RequestError(400, "invalid_run");
    const run = await loadRunForAction(await getDatabase(), session.ownerId, parsed.data.runId);
    if (!run) return Response.json({ error: "run_not_found" }, { status: 404, headers: NO_STORE });
    if (cancelRun(session.ownerId, parsed.data.runId) === "not_running") {
      return Response.json({ error: "not_running" }, { status: 409, headers: NO_STORE });
    }
    return Response.json({ cancelled: true }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
