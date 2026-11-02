import { z } from "zod";
import { getDatabase } from "@/db/client";
import { agentErrorResponse } from "@/lib/agents/http";
import { setAstraModeForOwner } from "@/lib/agents/service";
import { readBoundedJson, requireNoQuery, requireOwnerRequest, RequestError } from "@/lib/auth/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const bodySchema = z.object({
  enabled: z.boolean(),
  acknowledged: z.literal(true).optional(),
}).strict().refine((value) => !value.enabled || value.acknowledged === true, "acknowledgement_required");

// TASK-051. Astra Mode is changed only here, never through the generic agent update route.
export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const agentId = z.string().uuid().safeParse((await params).agentId);
    if (!agentId.success) throw new RequestError(400, "invalid_agent");
    const body = bodySchema.safeParse(await readBoundedJson(request, 4096));
    if (!body.success) {
      return Response.json({ error: body.error.issues.some((issue) => issue.message === "acknowledgement_required")
        ? "acknowledgement_required" : "invalid_input" }, { status: 400, headers: NO_STORE });
    }
    const astraMode = await setAstraModeForOwner(await getDatabase(), session.ownerId, agentId.data, body.data.enabled);
    return Response.json({ ok: true, astraMode }, { headers: NO_STORE });
  } catch (error) {
    const response = agentErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
