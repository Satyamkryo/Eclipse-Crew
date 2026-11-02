import { z } from "zod";
import { getDatabase } from "@/db/client";
import { requireNoQuery, requireOwnerRequest, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { revokeGrant } from "@/lib/approvals/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function POST(request: Request, { params }: { params: Promise<{ permissionId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const permissionId = z.string().uuid().safeParse((await params).permissionId);
    if (!permissionId.success) throw new RequestError(400, "invalid_permission");
    const database = await getDatabase();
    const revoked = await revokeGrant(database, session.ownerId, permissionId.data);
    if (!revoked) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    return Response.json({ revoked: true }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
