import { z } from "zod";
import { getDatabase } from "@/db/client";
import { readBoundedJson, requireNoQuery, requireOwnerRequest, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { getCrew, retryCrew } from "@/lib/crew/custom";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const paramsSchema = z.object({ crewId: z.string().uuid() }).strict();

export async function GET(request: Request, { params }: { params: Promise<{ crewId: string }> }) {
  try {
    const session = await requireOwnerRequest(request);
    requireNoQuery(request);
    const parsed = paramsSchema.safeParse(await params);
    if (!parsed.success) throw new RequestError(400, "invalid_crew");
    const crew = await getCrew(await getDatabase(), session.ownerId, parsed.data.crewId);
    if (!crew) throw new RequestError(404, "crew_not_found");
    return Response.json({ crew }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}

// Retry setup. The body must be empty: members, names and permissions come only from the stored crew. Repeating it is
// safe; each member is claimed atomically and keeps its agent UUID.
const retrySchema = z.object({}).strict();

export async function POST(request: Request, { params }: { params: Promise<{ crewId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const parsed = paramsSchema.safeParse(await params);
    if (!parsed.success) throw new RequestError(400, "invalid_crew");
    if (!retrySchema.safeParse(await readBoundedJson(request, 1024)).success) {
      return Response.json({ error: "invalid_input" }, { status: 400, headers: NO_STORE });
    }
    const crew = await retryCrew(await getDatabase(), session.ownerId, parsed.data.crewId);
    if (!crew) throw new RequestError(404, "crew_not_found");
    return Response.json({ crew }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
