import { z } from "zod";
import { requireOwnedAgent } from "@/lib/agents/access";
import { readBoundedJson, requireOwnerRequest, RequestError, requestErrorResponse } from "@/lib/auth/request";
import { desktopHandBack, handbackBodySchema } from "@/lib/desktop/client";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    const agentId = z.string().uuid().safeParse((await params).agentId);
    if (!agentId.success) throw new RequestError(400, "invalid_agent");
    if (new URL(request.url).search) throw new RequestError(400, "invalid_query");
    const body = handbackBodySchema.safeParse(await readBoundedJson(request));
    if (!body.success) throw new RequestError(400, "invalid_body");
    await requireOwnedAgent(session.ownerId, agentId.data);
    return Response.json(await desktopHandBack(agentId.data, session.ownerId, session.sessionRef, body.data));
  } catch (error) { return requestErrorResponse(error); }
}
