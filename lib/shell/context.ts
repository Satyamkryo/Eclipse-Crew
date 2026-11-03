import "server-only";

import { eq } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { owner } from "../../db/schema";
import { listAgentRecords } from "../agents/data";
import { resolveTimezone } from "../time/clock";
import type { AgentSummary } from "../../components/workspace/agent-pane";

type Database = Awaited<ReturnType<typeof getDatabase>>;

// Shared shell data for the standalone pages (Jobs, Security, Crew, Settings): the same
// owner-scoped agent summaries and owner chip the workspace sidebar shows.
export async function loadShellContext(database: Database, ownerId: string): Promise<{ agents: AgentSummary[]; ownerEmail: string; ownerTimeZone: string }> {
  const rows = await database.select({ timezone: owner.timezone, email: owner.login }).from(owner).where(eq(owner.id, ownerId)).limit(1);
  const ownerTimeZone = resolveTimezone(rows[0]?.timezone) ?? "UTC";
  const ownerEmail = rows[0]?.email ?? "Owner";
  const agents: AgentSummary[] = (await listAgentRecords(database, ownerId)).map((agent) => ({
    ...agent,
    status: agent.status === "active" ? "active" : "paused",
    attention: agent.attentionReason === "budget_warning" || agent.attentionReason === "budget_paused" || agent.attentionReason === "security_stop" || agent.attentionReason === "approval_pending" ? agent.attentionReason : null,
  }));
  return { agents, ownerEmail, ownerTimeZone };
}
