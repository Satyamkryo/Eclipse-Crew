import { z } from "zod";
import { getDatabase } from "@/db/client";
import { requireNoQuery, requireOwnerRequest, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { revokeGrantRecord } from "@/lib/approvals/store";
import { revokePushGrants } from "@/lib/egress/sync";

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
    const revoked = await revokeGrantRecord(database, session.ownerId, permissionId.data);
    if (!revoked) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    // TASK-073c. The persistent grant is revoked; unused exact proxy grants for the same
    // agent+repo+class must not survive it. A page-site grant has no proxy records to clear.
    const gitSite = /^github\.com\/[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(revoked.site);
    const proxyCleared = gitSite ? await revokePushGrants(revoked.agentId, revoked.site, revoked.actionClass) : true;
    return Response.json({ revoked: true, proxyCleared, ...(proxyCleared ? {} : { warning: "proxy_cleanup_failed" }) }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
