import { z } from "zod";
import { getDatabase } from "@/db/client";
import { requireNoQuery, requireOwnerRequest, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { buildProposalDetail } from "@/lib/heal/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

// TASK-044. One proposed repair with its diff. Another owner's proposal simply does not exist.
export async function GET(request: Request, { params }: { params: Promise<{ proposalId: string }> }) {
  try {
    const session = await requireOwnerRequest(request);
    requireNoQuery(request);
    const proposalId = z.string().uuid().safeParse((await params).proposalId);
    if (!proposalId.success) throw new RequestError(400, "invalid_proposal");
    const proposal = await buildProposalDetail(await getDatabase(), session.ownerId, proposalId.data);
    if (!proposal) return Response.json({ error: "proposal_not_found" }, { status: 404, headers: NO_STORE });
    return Response.json({ proposal }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
