import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { getDatabase } from "../../db/client";
import { agentPolicies, agents, teachRecordings } from "../../db/schema";
import { appendSoulVersion } from "../memory/store";
import { defaultSoul, type AgentCreateInput, type AgentUpdateInput } from "./schema";

type Database = Awaited<ReturnType<typeof getDatabase>>;
type AgentStore = Pick<Database, "select" | "update" | "delete">;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type AgentStatus = "active" | "paused";

const agentFields = {
  id: agents.id,
  name: agents.name,
  role: agents.role,
  soulMd: agents.soulMd,
  status: agents.status,
  astraMode: agents.astraMode,
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
    astraMode: agents.astraMode,
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

// TASK-058. The starter crew reuses one preallocated UUID across retries. The first caller inserts the app identity and
// records the audit row; a later caller that finds the same owner's row changes nothing and does not audit again.
export async function createAgentRecordIfAbsent(
  database: Database, ownerId: string, input: AgentCreateInput, agentId: string,
  audit?: (transaction: Transaction) => Promise<void>,
): Promise<{ agentId: string; created: boolean }> {
  return database.transaction(async (transaction) => {
    const existing = await transaction.select({ ownerId: agents.ownerId }).from(agents)
      .where(eq(agents.id, agentId)).limit(1);
    if (existing[0]) {
      if (existing[0].ownerId !== ownerId) throw new Error("agent_not_owned");
      return { agentId, created: false };
    }
    const inserted = await transaction.insert(agents).values({
      id: agentId,
      ownerId,
      name: input.name,
      role: input.role,
      soulMd: input.soulMd ?? defaultSoul(input.name, input.role),
      status: "paused",
      dailyBudgetCents: input.dailyBudgetCents,
      monthlyBudgetCents: input.monthlyBudgetCents,
    }).onConflictDoNothing({ target: agents.id }).returning({ agentId: agents.id });
    if (!inserted.length) {
      const existing = await transaction.select({ ownerId: agents.ownerId }).from(agents)
        .where(eq(agents.id, agentId)).limit(1);
      if (existing[0]?.ownerId !== ownerId) throw new Error("agent_not_owned");
      return { agentId, created: false };
    }
    await transaction.insert(agentPolicies).values({
      agentId,
      ownerId,
      tools: input.tools,
      domains: input.domains,
      actions: input.actions,
      // TASK-086. New agents read USER.md and their own MEMORY.md by default.
      memoryScopes: input.memoryScopes.length ? input.memoryScopes : ["global", "agent"],
    }).returning({ agentId: agentPolicies.agentId });
    await audit?.(transaction);
    return { agentId, created: true };
  });
}

export async function createAgentRecord(
  database: Database, ownerId: string, input: AgentCreateInput, agentId: string,
  audit?: (transaction: Transaction) => Promise<void>,
): Promise<{ agentId: string }> {
  await createAgentRecordIfAbsent(database, ownerId, input, agentId, audit);
  return { agentId };
}

export async function updateAgentRecord(
  database: Database, ownerId: string, agentId: string, input: AgentUpdateInput,
  audit?: (transaction: Transaction, change: { permissionsChanged: boolean }) => Promise<void>,
): Promise<boolean> {
  return database.transaction(async (transaction) => {
    const before = await transaction.select(policyFields).from(agentPolicies)
      .where(and(eq(agentPolicies.ownerId, ownerId), eq(agentPolicies.agentId, agentId))).limit(1);
    const beforeAgent = await transaction.select({ soulMd: agents.soulMd }).from(agents)
      .where(and(eq(agents.ownerId, ownerId), eq(agents.id, agentId))).limit(1);
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
    const previous = before[0];
    const permissionsChanged = !previous || !sameSet(previous.tools, input.tools) || !sameSet(previous.domains, input.domains) ||
      !sameSet(previous.actions, input.actions) || !sameSet(previous.memoryScopes, input.memoryScopes);
    if (beforeAgent[0] && beforeAgent[0].soulMd !== input.soulMd) {
      await appendSoulVersion(transaction, ownerId, agentId, beforeAgent[0].soulMd, input.soulMd);
    }
    await audit?.(transaction, { permissionsChanged });
    return true;
  });
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((value) => set.has(value));
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
