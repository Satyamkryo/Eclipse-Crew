import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { agentPolicies } from "@/db/schema";
import { recordAuditBestEffort } from "@/lib/security/audit";
import { readBoundedJson, requestErrorResponse, requireNoQuery, requireOwnerRequest } from "@/lib/auth/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ADR-036. `agentIds` scopes the switch to one crew's members; every id is checked against the owner's own agents.
const inputSchema = z.object({ enabled: z.boolean(), agentIds: z.array(z.string().uuid()).min(1).max(64).optional() }).strict();

// TASK-085. One explicit, owner-only switch. Existing agents are never changed by a new agent's defaults.
export async function POST(request: Request) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const parsed = inputSchema.safeParse(await readBoundedJson(request, 1024));
    if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400 });
    const database = await getDatabase();
    const changedAgents = await database.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${session.ownerId}), hashtext('handoff-switch'))`);
      const rows = await transaction.select({ agentId: agentPolicies.agentId, actions: agentPolicies.actions })
        .from(agentPolicies).where(eq(agentPolicies.ownerId, session.ownerId));
      const changed: string[] = [];
      const scope = parsed.data.agentIds ? new Set(parsed.data.agentIds.map((id) => id.toLowerCase())) : null;
      for (const row of rows) {
        if (scope && !scope.has(row.agentId.toLowerCase())) continue;
        const has = row.actions.some((action) => action.toLowerCase() === "handoff");
        if (parsed.data.enabled === has) continue;
        const actions = parsed.data.enabled
          ? [...row.actions, "handoff"]
          : row.actions.filter((action) => action.toLowerCase() !== "handoff");
        await transaction.update(agentPolicies).set({ actions, updatedAt: new Date() })
          .where(and(eq(agentPolicies.ownerId, session.ownerId), eq(agentPolicies.agentId, row.agentId)));
        changed.push(row.agentId);
      }
      return changed;
    });
    for (const agentId of changedAgents) {
      await recordAuditBestEffort(database, session.ownerId, {
        kind: "agent_updated", agentId, code: parsed.data.enabled ? "handoff_enabled" : "handoff_disabled",
      });
    }
    return Response.json({ ok: true, changed: changedAgents.length });
  } catch (error) {
    return requestErrorResponse(error);
  }
}
