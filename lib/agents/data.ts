import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { getDatabase } from "../../db/client";
import { agentPolicies, agents, teachRecordings } from "../../db/schema";
import { defaultSoul, type AgentCreateInput, type AgentUpdateInput } from "./schema";

type Database = Awaited<ReturnType<typeof getDatabase>>;
type AgentStore = Pick<Database, "select" | "update" | "delete">;

export type AgentStatus = "active" | "paused";

const agentFields = {
  id: agents.id,
  name: agents.name,
  role: agents.role,
  soulMd: agents.soulMd,
  status: agents.status,
  dailyBudgetCents: agents.dailyBudgetCents,
  monthlyBudgetCents: agents.monthlyBudgetCents,
  createdAt: agents.createdAt,
  updatedAt: agents.updatedAt,
};
const policyFields = {
  tools: agentPolicies.tools,
  domains: agentPolicies.domains,
  actions: agentPolicies.actions,
  memoryScopes: agentPolicies.memoryScopes,
};

export async function listAgentRecords(database: Database, ownerId: string) {
  return database.select({
    id: agents.id,
    name: agents.name,
    role: agents.role,
    status: agents.status,
    attentionReason: sql<string | null>`case when ${agents.attentionReason} is not null then ${agents.attentionReason} when exists (select 1 from ${teachRecordings} where ${teachRecordings.ownerId} = ${agents.ownerId} and ${teachRecordings.agentId} = ${agents.id} and ${teachRecordings.state} = 'paused') then 'teach_paused' else null end`,
  }).from(agents).where(eq(agents.ownerId, ownerId)).orderBy(asc(agents.name));
}

export async function getAgentRecord(database: Database, ownerId: string, agentId: string) {
  const rows = await database.select(agentFields).from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.id, agentId))).limit(1);
  const agent = rows[0];
  if (!agent) return undefined;
  const policies = await database.select(policyFields).from(agentPolicies)
    .where(and(eq(agentPolicies.ownerId, ownerId), eq(agentPolicies.agentId, agentId))).limit(1);
  const policy = policies[0];
  if (!policy) return undefined;
  return { ...agent, ...policy, status: agent.status as AgentStatus };
}

export async function getAgentIdentity(
  database: AgentStore, ownerId: string, agentId: string, { forUpdate = false } = {},
) {
  const query = database.select({ id: agents.id, ownerId: agents.ownerId, name: agents.name, status: agents.status })
    .from(agents).where(and(eq(agents.ownerId, ownerId), eq(agents.id, agentId))).limit(1);
  const rows = await (forUpdate ? query.for("update") : query);
  const agent = rows[0];
  return agent ? { ...agent, status: agent.status as AgentStatus } : undefined;
}

export async function createAgentRecord(
  database: Database, ownerId: string, input: AgentCreateInput, agentId: string,
): Promise<{ agentId: string }> {
  await database.transaction(async (transaction) => {
    await transaction.insert(agents).values({
      id: agentId,
      ownerId,
      name: input.name,
      role: input.role,
      soulMd: input.soulMd ?? defaultSoul(input.name, input.role),
      status: "paused",
      dailyBudgetCents: input.dailyBudgetCents,
      monthlyBudgetCents: input.monthlyBudgetCents,
    }).returning({ agentId: agents.id });
    await transaction.insert(agentPolicies).values({
      agentId,
      ownerId,
      tools: input.tools,
      domains: input.domains,
      actions: input.actions,
      memoryScopes: input.memoryScopes,
    }).returning({ agentId: agentPolicies.agentId });
  });
  return { agentId };
}

export async function updateAgentRecord(
  database: Database, ownerId: string, agentId: string, input: AgentUpdateInput,
): Promise<boolean> {
  return database.transaction(async (transaction) => {
    const updated = await transaction.update(agents).set({
      name: input.name,
      role: input.role,
      soulMd: input.soulMd,
      dailyBudgetCents: input.dailyBudgetCents,
      monthlyBudgetCents: input.monthlyBudgetCents,
      updatedAt: new Date(),
    }).where(and(eq(agents.ownerId, ownerId), eq(agents.id, agentId))).returning({ agentId: agents.id });
    if (!updated[0]) return false;
    const updatedPolicy = await transaction.update(agentPolicies).set({
      tools: input.tools,
      domains: input.domains,
      actions: input.actions,
      memoryScopes: input.memoryScopes,
      updatedAt: new Date(),
    }).where(and(eq(agentPolicies.ownerId, ownerId), eq(agentPolicies.agentId, agentId)))
      .returning({ agentId: agentPolicies.agentId });
    if (!updatedPolicy[0]) {
      await transaction.insert(agentPolicies).values({
        agentId,
        ownerId,
        tools: input.tools,
        domains: input.domains,
        actions: input.actions,
        memoryScopes: input.memoryScopes,
      }).returning({ agentId: agentPolicies.agentId });
    }
    return true;
  });
}

export async function setAgentStatus(
  database: AgentStore, ownerId: string, agentId: string, status: AgentStatus,
): Promise<boolean> {
  const updated = await database.update(agents).set({ status, updatedAt: new Date() })
    .where(and(eq(agents.ownerId, ownerId), eq(agents.id, agentId))).returning({ agentId: agents.id });
  return Boolean(updated[0]);
}

export async function deleteAgentRecord(database: AgentStore, ownerId: string, agentId: string): Promise<boolean> {
  const deleted = await database.delete(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.id, agentId))).returning({ agentId: agents.id });
  return Boolean(deleted[0]);
}
