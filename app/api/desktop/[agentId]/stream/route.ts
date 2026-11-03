import { z } from "zod";
import { requireOwnedAgent } from "@/lib/agents/access";
import { requireOwnerRequest, RequestError, requestErrorResponse } from "@/lib/auth/request";
import { desktopSession } from "@/lib/desktop/client";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const session = await requireOwnerRequest(request);
    const agentId = z.string().uuid().safeParse((await params).agentId);
    if (!agentId.success) throw new RequestError(400, "invalid_agent");
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "connectionId") || url.searchParams.getAll("connectionId").length > 1)
      throw new RequestError(400, "invalid_query");
    const connectionId = url.searchParams.get("connectionId");
    if (connectionId !== null && !z.string().uuid().safeParse(connectionId).success) throw new RequestError(400, "invalid_connection");
    const agent = await requireOwnedAgent(session.ownerId, agentId.data);
    if (agent.status !== "active") throw new RequestError(409, "agent_paused");
    const status = await desktopSession(agentId.data, session.ownerId, "session.status");
    // The viewer streams the graphical desktop; a stopped browser alone does not stop the stream.
    if (status.state !== "running" || status.graphics !== "running" || !status.generation) throw new RequestError(409, "session_not_running");
    return Response.json({ agentId: agentId.data, ownerId: session.ownerId, sessionRef: session.sessionRef,
      generation: status.generation, state: status.state, graphics: status.graphics, browser: status.browser });
  } catch (error) { return requestErrorResponse(error); }
}
