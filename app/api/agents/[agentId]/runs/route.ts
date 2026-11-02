import { z } from "zod";
import { getDatabase } from "@/db/client";
import { requireOwnerRequest, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { listRuns } from "@/lib/receipts/history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

// The History tab's list: this agent's newest runs (at most 20). Another owner's agent simply has no rows.
export async function GET(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const session = await requireOwnerRequest(request);
    if (new URL(request.url).search) throw new RequestError(400, "invalid_query");
    const parsed = z.object({ agentId: z.string().uuid() }).safeParse(await params);
    if (!parsed.success) throw new RequestError(400, "invalid_agent");
    const runs = await listRuns(await getDatabase(), session.ownerId, parsed.data.agentId);
    return Response.json({ runs }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
