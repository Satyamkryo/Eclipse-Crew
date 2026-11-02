import "server-only";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDatabase } from "../../db/client";
import { desktopCreateAgent, desktopDeleteAgent, desktopSession } from "../desktop/client";
import { createAgentRecord, deleteAgentRecord, getAgentIdentity, setAgentStatus, updateAgentRecord } from "./data";
import { clearAgentAttention, readBudgetStatus } from "../costs/store";
import { clearTripwire } from "../security/tripwire";
import { pushAgentPolicy, syncAgentEgress, clearAgentTrip } from "../egress/sync";
import type { AgentCreateInput, AgentUpdateInput } from "./schema";

type Database = Awaited<ReturnType<typeof getDatabase>>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type AgentIdentity = NonNullable<Awaited<ReturnType<typeof getAgentIdentity>>>;
type DesktopOperations = {
  desktopCreateAgent: typeof desktopCreateAgent;
  desktopDeleteAgent: typeof desktopDeleteAgent;
  desktopSession: typeof desktopSession;
};

const defaultDesktop: DesktopOperations = { desktopCreateAgent, desktopDeleteAgent, desktopSession };

export class AgentLifecycleError extends Error {
  constructor(public code: "agent_not_found" | "confirmation_mismatch" | "desktop_setup_failed" | "budget_exhausted") {
    super(code);
  }
}

export async function createAgentForOwner(
  database: Database, ownerId: string, input: AgentCreateInput, desktop: DesktopOperations = defaultDesktop,
) {
  const agentId = randomUUID();
  await createAgentRecord(database, ownerId, input, agentId);
  try {
    await desktop.desktopCreateAgent(agentId, ownerId);
    const status = await desktop.desktopSession(agentId, ownerId, "session.start");
    if (status.state !== "running" || !status.generation) throw new Error("agent_not_running");
    if (!await setAgentStatus(database, ownerId, agentId, "active")) throw new Error("agent_missing");
    await syncEgress(() => syncAgentEgress(database, ownerId, agentId));
    return { agentId, desktopReady: true };
  } catch {
    return { agentId, desktopReady: false };
  }
}

export async function updateAgentForOwner(
  database: Database, ownerId: string, agentId: string, input: AgentUpdateInput,
) {
  const updated = await updateAgentRecord(database, ownerId, agentId, input);
  if (!updated) throw new AgentLifecycleError("agent_not_found");
  await syncEgress(() => syncAgentEgress(database, ownerId, agentId));
}

export async function pauseAgentForOwner(
  database: Database, ownerId: string, agentId: string, desktop: DesktopOperations = defaultDesktop,
) {
  await withLockedAgent(database, ownerId, agentId, async (transaction) => {
    await desktop.desktopSession(agentId, ownerId, "session.stop");
    if (!await setAgentStatus(transaction, ownerId, agentId, "paused")) {
      throw new AgentLifecycleError("agent_not_found");
    }
  });
  await syncEgress(() => syncAgentEgress(database, ownerId, agentId));
}

export async function resumeAgentForOwner(
  database: Database, ownerId: string, agentId: string, desktop: DesktopOperations = defaultDesktop,
  budgetStatus: typeof readBudgetStatus = readBudgetStatus,
) {
  await withLockedAgent(database, ownerId, agentId, async (transaction) => {
    const budget = await budgetStatus(transaction, ownerId, agentId, new Date());
    if (budget.state === "paused") throw new AgentLifecycleError("budget_exhausted");
    try {
      await desktop.desktopCreateAgent(agentId, ownerId);
      const status = await desktop.desktopSession(agentId, ownerId, "session.start");
      if (status.state !== "running" || !status.generation) throw new Error("agent_not_running");
    } catch {
      throw new AgentLifecycleError("desktop_setup_failed");
    }
    if (!await setAgentStatus(transaction, ownerId, agentId, "active")) {
      throw new AgentLifecycleError("agent_not_found");
    }
    await clearAgentAttention(transaction, ownerId, agentId);
  });
  clearTripwire(ownerId, agentId);
  await syncEgress(() => clearAgentTrip(database, ownerId, agentId));
  await syncEgress(() => syncAgentEgress(database, ownerId, agentId));
}

export async function deleteAgentForOwner(
  database: Database, ownerId: string, agentId: string, confirmation: string,
  desktop: DesktopOperations = defaultDesktop,
) {
  await withLockedAgent(database, ownerId, agentId, async (transaction, agent) => {
    if (agent.name !== confirmation) throw new AgentLifecycleError("confirmation_mismatch");
    await desktop.desktopDeleteAgent(agentId, ownerId);
    if (!await deleteAgentRecord(transaction, ownerId, agentId)) {
      throw new AgentLifecycleError("agent_not_found");
    }
  });
  await syncEgress(() => pushAgentPolicy({ agentId, domains: [], blocked: true, canaryHashes: [] }));
}

async function syncEgress(push: () => Promise<unknown>): Promise<void> {
  try { await push(); } catch { /* the proxy fails closed; the 60 s loop retries */ }
}

async function withLockedAgent<Result>(
  database: Database, ownerId: string, agentId: string,
  operation: (transaction: Transaction, agent: AgentIdentity) => Promise<Result>,
) {
  return database.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL lock_timeout = '5s'`);
    const agent = await getAgentIdentity(transaction, ownerId, agentId, { forUpdate: true });
    if (!agent) throw new AgentLifecycleError("agent_not_found");
    return operation(transaction, agent);
  });
}
