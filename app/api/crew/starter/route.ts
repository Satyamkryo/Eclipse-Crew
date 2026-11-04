import { getDatabase } from "@/db/client";
import { requireNoQuery, requireOwnerRequest, requestErrorResponse, readBoundedJson } from "@/lib/auth/request";
import { starterCrewPostSchema } from "@/lib/crew/schema";
import { createOrResumeStarterCrew, getStarterCrew } from "@/lib/crew/starter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function GET(request: Request) {
  try {
    const session = await requireOwnerRequest(request);
    requireNoQuery(request);
    const crew = await getStarterCrew(await getDatabase(), session.ownerId);
    return Response.json(crew, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}

// The body must be empty: member identities and policies come only from the server-side templates. Repeating the request
// resumes the same setup and never creates a second crew.
export async function POST(request: Request) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const parsed = starterCrewPostSchema.safeParse(await readBoundedJson(request, 1024));
    if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400, headers: NO_STORE });
    const crew = await createOrResumeStarterCrew(await getDatabase(), session.ownerId);
    return Response.json(crew, { status: 200, headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
