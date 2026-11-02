import { z } from "zod";
import { getDatabase } from "@/db/client";
import { getAgentIdentity } from "@/lib/agents/data";
import { requireNoQuery, requireOwnerRequest, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { listGrants } from "@/lib/approvals/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function GET(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const session = await requireOwnerRequest(request);
    requireNoQuery(request);
    const agentId = z.string().uuid().safeParse((await params).agentId);
    if (!agentId.success) throw new RequestError(400, "invalid_agent");
    const database = await getDatabase();
    const agent = await getAgentIdentity(database, session.ownerId, agentId.data);
    if (!agent) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    const grants = await listGrants(database, session.ownerId, agentId.data);
    return Response.json({
      permissions: grants.map((grant) => ({
        id: grant.id,
        site: grant.site,
        actionClass: grant.actionClass,
        maxPerDay: grant.maxPerDay,
        createdAt: grant.createdAt.toISOString(),
      })),
    }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
