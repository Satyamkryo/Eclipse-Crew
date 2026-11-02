import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDatabase } from "../../db/client";
import { agents } from "../../db/schema";
import { desktopCreateAgent, desktopDeleteAgent, desktopSession } from "../desktop/client";
import { createAgentRecord, deleteAgentRecord, getAgentIdentity, setAgentStatus, updateAgentRecord } from "./data";
import { clearAgentAttention, readBudgetStatus } from "../costs/store";
import { clearTripwire } from "../security/tripwire";
import { pushAgentPolicy, syncAgentEgress, clearAgentTrip } from "../egress/sync";
import { recordAudit, type AuditExecutor } from "../security/audit";
import { scheduleMirror } from "../memory/mirror";
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

// TASK-051. Set only through setAstraModeForOwner, never through the generic agent update route.

export async function createAgentForOwner(
  database: Database, ownerId: string, input: AgentCreateInput, desktop: DesktopOperations = defaultDesktop,
) {
  const agentId = randomUUID();
  await createAgentRecord(database, ownerId, input, agentId, async (transaction) => {
    await recordAudit(transaction as unknown as AuditExecutor, ownerId, { kind: "agent_created", agentId });
  });
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
  const updated = await updateAgentRecord(database, ownerId, agentId, input, async (transaction, { permissionsChanged }) => {
    await recordAudit(transaction as unknown as AuditExecutor, ownerId, {
      kind: "agent_updated", agentId, code: permissionsChanged ? "permissions_changed" : "settings_changed",
    });
  });
  if (!updated) throw new AgentLifecycleError("agent_not_found");
  void scheduleMirror(database, ownerId, agentId).catch(() => undefined);
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
    await recordAudit(transaction as unknown as AuditExecutor, ownerId, { kind: "agent_paused", agentId });
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
    await recordAudit(transaction as unknown as AuditExecutor, ownerId, { kind: "agent_resumed", agentId });
  });
  clearTripwire(ownerId, agentId);
  await syncEgress(() => clearAgentTrip(database, ownerId, agentId));
  await syncEgress(() => syncAgentEgress(database, ownerId, agentId));
}

// TASK-051. The only way to change Astra Mode. The dedicated route and its acknowledgement keep it off generic updates.
export async function setAstraModeForOwner(
  database: Database, ownerId: string, agentId: string, enabled: boolean,
): Promise<boolean> {
  await withLockedAgent(database, ownerId, agentId, async (transaction) => {
    const updated = await transaction.update(agents).set({ astraMode: enabled, updatedAt: new Date() })
      .where(and(eq(agents.ownerId, ownerId), eq(agents.id, agentId))).returning({ agentId: agents.id });
    if (!updated[0]) throw new AgentLifecycleError("agent_not_found");
    await recordAudit(transaction as unknown as AuditExecutor, ownerId, {
      kind: enabled ? "astra_enabled" : "astra_disabled", agentId,
    });
  });
  return enabled;
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
    await recordAudit(transaction as unknown as AuditExecutor, ownerId, { kind: "agent_deleted", agentId });
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
