import { getDatabase } from "@/db/client";
import { requestErrorResponse, requireOwnerRequest, RequestError } from "@/lib/auth/request";
import { listJobs } from "@/lib/jobs/data";
import { decodeCursor, jobListQuerySchema } from "@/lib/jobs/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

// TASK-042. Crew-wide runs, newest first. Every row is scoped by the owner; a foreign agent filter simply matches nothing.
export async function GET(request: Request) {
  try {
    const session = await requireOwnerRequest(request);
    const query: Record<string, string> = {};
    for (const [key, value] of new URL(request.url).searchParams) query[key] = value;
    const parsed = jobListQuerySchema.safeParse(query);
    if (!parsed.success) throw new RequestError(400, "invalid_query");
    if (parsed.data.cursor && !decodeCursor(parsed.data.cursor)) throw new RequestError(400, "invalid_cursor");
    const result = await listJobs(await getDatabase(), session.ownerId, parsed.data);
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
