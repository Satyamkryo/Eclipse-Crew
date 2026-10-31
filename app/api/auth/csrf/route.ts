import { requireOwnerRequest, requireNoQuery, requestErrorResponse } from "@/lib/auth/request";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const session = await requireOwnerRequest(request);
    requireNoQuery(request);
    return Response.json({ csrfToken: session.csrfToken });
  } catch (error) { return requestErrorResponse(error); }
}
