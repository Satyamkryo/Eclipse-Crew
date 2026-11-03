import { z } from "zod";
import { getAgentIdentity } from "@/lib/agents/data";
import { requireNoQuery, requireOwnerRequest, requestErrorResponse } from "@/lib/auth/request";
import { getDatabase } from "@/db/client";
import { loadLiveRun } from "@/lib/runs/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const session = await requireOwnerRequest(request);
    requireNoQuery(request);
    const parsed = z.string().uuid().safeParse((await params).agentId);
    if (!parsed.success) return Response.json({ error: "invalid_agent" }, { status: 400 });
    const database = await getDatabase();
    const agent = await getAgentIdentity(database, session.ownerId, parsed.data);
    if (!agent) return Response.json({ error: "agent_not_found" }, { status: 404 });
    return Response.json({ live: await loadLiveRun(database, session.ownerId, parsed.data) },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return requestErrorResponse(error);
  }
}
