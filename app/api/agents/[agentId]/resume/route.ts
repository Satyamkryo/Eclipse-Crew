import { z } from "zod";
import { getDatabase } from "@/db/client";
import { agentErrorResponse } from "@/lib/agents/http";
import { resumeAgentForOwner } from "@/lib/agents/service";
import { requireNoQuery, requireOwnerRequest, RequestError } from "@/lib/auth/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const agentId = z.string().uuid().safeParse((await params).agentId);
    if (!agentId.success) throw new RequestError(400, "invalid_agent");
    await resumeAgentForOwner(await getDatabase(), session.ownerId, agentId.data);
    return Response.json({ status: "active" });
  } catch (error) {
    return agentErrorResponse(error);
  }
}
