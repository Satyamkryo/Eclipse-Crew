import { eq } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { agentPolicies } from "@/db/schema";
import { requireNoQuery, requireOwnerRequest, requestErrorResponse } from "@/lib/auth/request";
import { recordAudit, type AuditExecutor } from "@/lib/security/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

// TASK-086. One click upgrades every agent: automatic memory and the default global + agent scopes. It is audited.
export async function POST(request: Request) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const database = await getDatabase();
    const policies = await database.select({ agentId: agentPolicies.agentId, scopes: agentPolicies.memoryScopes, mode: agentPolicies.memoryMode })
      .from(agentPolicies).where(eq(agentPolicies.ownerId, session.ownerId));
    let upgraded = 0;
    for (const policy of policies) {
      if (policy.mode === "auto" && policy.scopes.includes("global") && policy.scopes.includes("agent")) continue;
      const scopes = [...new Set([...policy.scopes, "global", "agent"])];
      await database.update(agentPolicies).set({ memoryMode: "auto", memoryScopes: scopes, updatedAt: new Date() })
        .where(eq(agentPolicies.agentId, policy.agentId));
      await recordAudit(database as unknown as AuditExecutor, session.ownerId, {
        kind: "memory_upgrade_applied", agentId: policy.agentId, ref: policy.agentId,
      }).catch(() => undefined);
      upgraded += 1;
    }
    return Response.json({ upgraded }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
