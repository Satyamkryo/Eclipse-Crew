import { eq } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { owner } from "@/db/schema";
import { requestErrorResponse, requireOwnerRequest, RequestError } from "@/lib/auth/request";
import { listUpcoming } from "@/lib/jobs/upcoming";
import { jobUpcomingQuerySchema } from "@/lib/jobs/view";
import { resolveTimezone } from "@/lib/time/clock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

// TASK-042. Occurrences of active routines in the owner's local timezone, plus paused routines.
export async function GET(request: Request) {
  try {
    const session = await requireOwnerRequest(request);
    const query: Record<string, string> = {};
    for (const [key, value] of new URL(request.url).searchParams) query[key] = value;
    const parsed = jobUpcomingQuerySchema.safeParse(query);
    if (!parsed.success) throw new RequestError(400, "invalid_query");
    const database = await getDatabase();
    let timezone = "UTC";
    try {
      const rows = await database.select({ timezone: owner.timezone }).from(owner).where(eq(owner.id, session.ownerId)).limit(1);
      timezone = resolveTimezone(rows[0]?.timezone) ?? "UTC";
    } catch { /* fall back to UTC */ }
    const view = await listUpcoming(database, session.ownerId, {
      days: Number(parsed.data.days) as 1 | 7 | 30,
      ...(parsed.data.agent ? { agentId: parsed.data.agent } : {}),
      timezone,
    });
    return Response.json(view, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
