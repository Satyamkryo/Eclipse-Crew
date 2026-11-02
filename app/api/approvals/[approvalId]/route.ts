import { z } from "zod";
import { getDatabase } from "@/db/client";
import { requireNoQuery, requireOwnerRequest, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { approvalView, expireApproval, getApproval } from "@/lib/approvals/store";
import { APPROVAL_WAIT_MS } from "@/lib/approvals/types";
import { hasWaiter } from "@/lib/approvals/waiters";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function GET(request: Request, { params }: { params: Promise<{ approvalId: string }> }) {
  try {
    const session = await requireOwnerRequest(request);
    requireNoQuery(request);
    const approvalId = z.string().uuid().safeParse((await params).approvalId);
    if (!approvalId.success) throw new RequestError(400, "invalid_approval");
    const database = await getDatabase();
    let approval = await getApproval(database, session.ownerId, approvalId.data);
    if (!approval) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    // An app restart (or a run that stopped) leaves no waiter. After the wait limit the request is honestly expired.
    if (approval.state === "pending" && !hasWaiter(approval.id) && Date.now() - approval.createdAt.getTime() > APPROVAL_WAIT_MS) {
      await expireApproval(database, session.ownerId, approval.id);
      approval = (await getApproval(database, session.ownerId, approval.id)) ?? approval;
    }
    return Response.json({ approval: approvalView(approval) }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
