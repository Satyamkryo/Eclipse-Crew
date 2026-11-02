import { z } from "zod";
import { getDatabase } from "@/db/client";
import { getAgentIdentity } from "@/lib/agents/data";
import { appendAgentCard } from "@/lib/chat/data";
import { requireNoQuery, requireOwnerRequest, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { haltAgent } from "@/lib/security/halt";
import { createKillSwitchPorts } from "@/lib/security/kill-switch";
import { auditSigningAvailable, recordAuditBestEffort } from "@/lib/security/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

// TASK-052. Stop one agent. Each halt step is independent and time-bounded, so this answers even when the desktop or
// the egress proxy hangs. The audit entry is written afterwards and never blocks the stop.
export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const agentId = z.string().uuid().safeParse((await params).agentId);
    if (!agentId.success) throw new RequestError(400, "invalid_agent");
    const database = await getDatabase();
    const agent = await getAgentIdentity(database, session.ownerId, agentId.data);
    if (!agent) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    const result = await haltAgent({
      ...createKillSwitchPorts(database),
      postCard: (ownerId, id) => appendAgentCard(database, ownerId, id, {
        card: { type: "message", text: "Stopped by you." }, sourceTag: "system",
      }),
    }, { ownerId: session.ownerId, agentId: agentId.data, reason: "agent" });
    const audited = await recordAuditBestEffort(database, session.ownerId, { kind: "agent_stopped", agentId: agentId.data });
    return Response.json({
      ok: result.ok, steps: result.steps, audit: auditSigningAvailable() ? (audited ? "recorded" : "failed") : "unavailable",
    }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
