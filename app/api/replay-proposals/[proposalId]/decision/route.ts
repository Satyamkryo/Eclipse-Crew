import { z } from "zod";
import { getDatabase } from "@/db/client";
import { readBoundedJson, requireNoQuery, requireOwnerRequest, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { buildProposalDetail, decideProposal } from "@/lib/heal/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const bodySchema = z.object({ decision: z.enum(["approve", "reject"]) }).strict();

// TASK-044. Approve appends the next replay version; reject leaves the current version active. A second decision or a stale
// base changes nothing. Approval grants no permission: replay still checks the agent's current Actions allowlist.
export async function POST(request: Request, { params }: { params: Promise<{ proposalId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const proposalId = z.string().uuid().safeParse((await params).proposalId);
    if (!proposalId.success) throw new RequestError(400, "invalid_proposal");
    const body = bodySchema.safeParse(await readBoundedJson(request, 4096));
    if (!body.success) return Response.json({ error: "invalid_input" }, { status: 400, headers: NO_STORE });
    const database = await getDatabase();
    const result = await decideProposal(database, session.ownerId, proposalId.data, body.data.decision);
    if (!result.ok) {
      const status = result.error === "not_found" ? 404 : 409;
      return Response.json({ error: result.error }, { status, headers: NO_STORE });
    }
    const proposal = await buildProposalDetail(database, session.ownerId, proposalId.data);
    return Response.json({ proposal }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
