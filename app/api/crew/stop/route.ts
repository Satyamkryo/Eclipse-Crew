import { getDatabase } from "@/db/client";
import { requireNoQuery, requireOwnerRequest, requestErrorResponse } from "@/lib/auth/request";
import { stopCrew } from "@/lib/security/halt";
import { createKillSwitchPorts } from "@/lib/security/kill-switch";
import { auditSigningAvailable, recordAuditBestEffort } from "@/lib/security/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

// TASK-052. Set the crew gate first, then halt every agent independently. The gate is what refuses new runs.
export async function POST(request: Request) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const database = await getDatabase();
    const result = await stopCrew(createKillSwitchPorts(database), session.ownerId);
    const audited = await recordAuditBestEffort(database, session.ownerId, { kind: "crew_stopped" });
    return Response.json({
      ok: result.ok, agents: result.agents,
      audit: auditSigningAvailable() ? (audited ? "recorded" : "failed") : "unavailable",
    }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
