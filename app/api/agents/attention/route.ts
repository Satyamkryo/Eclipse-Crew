import { getDatabase } from "@/db/client";
import { requireNoQuery, requireOwnerRequest, requestErrorResponse } from "@/lib/auth/request";
import { listAgentAttention } from "@/lib/costs/store";
import { ensureSecurityLoops } from "@/lib/security/loops";
import { and, desc, eq } from "drizzle-orm";
import { teachRecordings } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function GET(request: Request) {
  try {
    const session = await requireOwnerRequest(request);
    requireNoQuery(request);
    ensureSecurityLoops();
    const database = await getDatabase();
    const agents = await listAgentAttention(database, session.ownerId);
    const paused = await database.select({ agentId: teachRecordings.agentId, updatedAt: teachRecordings.updatedAt }).from(teachRecordings)
      .where(and(eq(teachRecordings.ownerId, session.ownerId), eq(teachRecordings.state, "paused"))).orderBy(desc(teachRecordings.updatedAt));
    const captures = new Map<string, Date>();
    for (const capture of paused) if (!captures.has(capture.agentId)) captures.set(capture.agentId, capture.updatedAt);
    return Response.json({
      agents: agents.map((agent) => ({
        id: agent.id,
        attention: agent.attention === "budget_warning" || agent.attention === "budget_paused" || agent.attention === "security_stop" || agent.attention === "approval_pending" ? agent.attention : captures.has(agent.id) ? "teach_paused" : null,
        updatedAt: (captures.has(agent.id) && !agent.attention ? captures.get(agent.id)! : agent.updatedAt).toISOString(),
      })),
    }, { headers: HEADERS });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(HEADERS)) response.headers.set(key, value);
    return response;
  }
}
