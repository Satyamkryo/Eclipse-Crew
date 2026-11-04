import { getDatabase } from "@/db/client";
import { requireNoQuery, requireOwnerRequest, requestErrorResponse, readBoundedJson } from "@/lib/auth/request";
import { createCrew, crewCreateSchema, listCrews } from "@/lib/crew/custom";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function GET(request: Request) {
  try {
    const session = await requireOwnerRequest(request);
    requireNoQuery(request);
    const crews = await listCrews(await getDatabase(), session.ownerId);
    return Response.json({ crews }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}

// Creates a named crew of up to 6 agents. Only the crew name and each
// member's name + role are required; persona, budgets and the permission
// set fill from safe defaults server-side. Repeating is never implicit:
// each POST creates one new crew.
export async function POST(request: Request) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const parsed = crewCreateSchema.safeParse(await readBoundedJson(request, 8192));
    if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400, headers: NO_STORE });
    const crew = await createCrew(await getDatabase(), session.ownerId, parsed.data);
    return Response.json({ crew }, { status: 201, headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
