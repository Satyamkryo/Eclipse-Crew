import { destroySession } from "@/lib/auth/session";
import { requireOwnerRequest, requireNoQuery, requestErrorResponse } from "@/lib/auth/request";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    await destroySession(session);
    return Response.json({ ok: true });
  } catch (error) { return requestErrorResponse(error); }
}
