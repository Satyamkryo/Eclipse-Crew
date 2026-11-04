import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "@/db/client";
import { runs } from "@/db/schema";
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
      // TASK-085. A run held by another process sees this flag on its next heartbeat.
      const updated = await (await getDatabase()).update(runs).set({ cancelRequestedAt: new Date() })
        .where(and(eq(runs.id, parsed.data.runId), eq(runs.ownerId, session.ownerId), isNull(runs.signature)))
        .returning({ id: runs.id });
      if (!updated[0]) return Response.json({ error: "not_running" }, { status: 409, headers: NO_STORE });
      return Response.json({ cancelling: true }, { headers: NO_STORE });
    }
    return Response.json({ cancelled: true }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
