import { z } from "zod";
import { getDatabase } from "@/db/client";
import { readBoundedJson, requireNoQuery, requireOwnerRequest, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { approvalView, decideApproval, expireApproval, getApproval } from "@/lib/approvals/store";
import { APPROVAL_DECISIONS } from "@/lib/approvals/types";
import { hasWaiter, resolveDecision } from "@/lib/approvals/waiters";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const bodySchema = z.object({ decision: z.enum(APPROVAL_DECISIONS) }).strict();

// TASK-050. One decision wins. A request with no waiting run (an app restart, or a run already stopped) becomes expired
// instead of being quietly allowed. A deny can never be turned into an allow by a later request.
export async function POST(request: Request, { params }: { params: Promise<{ approvalId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const approvalId = z.string().uuid().safeParse((await params).approvalId);
    if (!approvalId.success) throw new RequestError(400, "invalid_approval");
    const body = bodySchema.safeParse(await readBoundedJson(request, 4096));
    if (!body.success) return Response.json({ error: "invalid_input" }, { status: 400, headers: NO_STORE });

    const database = await getDatabase();
    const current = await getApproval(database, session.ownerId, approvalId.data);
    if (!current) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    if (current.state !== "pending") return Response.json({ error: "already_decided" }, { status: 409, headers: NO_STORE });
    if (body.data.decision === "always_allow" && current.site.length === 0) {
      return Response.json({ error: "site_unknown" }, { status: 409, headers: NO_STORE });
    }
    if (!hasWaiter(approvalId.data)) {
      await expireApproval(database, session.ownerId, approvalId.data);
      return Response.json({ error: "expired" }, { status: 409, headers: NO_STORE });
    }

    const result = await decideApproval(database, session.ownerId, approvalId.data, body.data.decision);
    if (!result.ok) {
      const status = result.error === "not_found" ? 404 : 409;
      return Response.json({ error: result.error }, { status, headers: NO_STORE });
    }
    resolveDecision(approvalId.data, body.data.decision);
    return Response.json({ approval: approvalView(result.approval) }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
