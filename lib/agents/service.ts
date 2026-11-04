import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDatabase } from "../../db/client";
import { agents, owner } from "../../db/schema";
import { desktopCreateAgent, desktopDeleteAgent, desktopSession } from "../desktop/client";
import { createAgentRecordIfAbsent, deleteAgentRecord, getAgentIdentity, getAgentRecord, setAgentStatus, updateAgentRecord } from "./data";
import { clearAgentAttention, readBudgetStatus } from "../costs/store";
import { clearTripwire } from "../security/tripwire";
import { pushAgentPolicy, syncAgentEgress, clearAgentTrip } from "../egress/sync";
import { recordAudit, type AuditExecutor } from "../security/audit";
import { scheduleMirror } from "../memory/mirror";
import type { AgentCreateInput, AgentUpdateInput } from "./schema";

type Database = Awaited<ReturnType<typeof getDatabase>>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type AgentIdentity = NonNullable<Awaited<ReturnType<typeof getAgentIdentity>>>;
export type DesktopOperations = {
  desktopCreateAgent: typeof desktopCreateAgent;
  desktopDeleteAgent: typeof desktopDeleteAgent;
  desktopSession: typeof desktopSession;
};

const defaultDesktop: DesktopOperations = { desktopCreateAgent, desktopDeleteAgent, desktopSession };

export type AgentLifecycleCode = "agent_not_found" | "confirmation_mismatch" | "desktop_setup_failed" | "budget_exhausted" | "crew_stopped" |
  "agent_paused" | "security_stopped" | "desktop_start_failed" | "desktop_stop_failed" | "browser_start_failed" | "browser_stop_failed" |
  "desktop_unavailable" | "profile_busy_or_unsafe" | "display_conflict";
export class AgentLifecycleError extends Error {
  constructor(public code: AgentLifecycleCode) {
    super(code);
  }
}
const DESKTOP_CODES = new Set<AgentLifecycleCode>(["profile_busy_or_unsafe", "display_conflict", "desktop_start_failed", "desktop_stop_failed",
  "browser_start_failed", "browser_stop_failed", "desktop_unavailable"]);
const desktopCode = (error: unknown, fallback: AgentLifecycleCode): AgentLifecycleCode => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && DESKTOP_CODES.has(code as AgentLifecycleCode) ? code as AgentLifecycleCode : fallback;
};

// TASK-051. Set only through setAstraModeForOwner, never through the generic agent update route.

// TASK-058. Split from provisioning so the starter crew can persist each UUID first, create the app identity exactly once,
// and retry the desktop step without granting anything new.
export async function createAgentIdentity(
  database: Database, ownerId: string, input: AgentCreateInput, agentId: string,
) {
  return createAgentRecordIfAbsent(database, ownerId, input, agentId, async (transaction) => {
    await recordAudit(transaction as unknown as AuditExecutor, ownerId, { kind: "agent_created", agentId });
  });
}

export async function provisionAgentForOwner(
  database: Database, ownerId: string, agentId: string, desktop: DesktopOperations = defaultDesktop,
): Promise<{ ready: boolean; code?: AgentLifecycleCode }> {
  try {
    await desktop.desktopCreateAgent(agentId, ownerId);
    const status = await desktop.desktopSession(agentId, ownerId, "session.start");
    if (status.state !== "running" || !status.generation) throw new Error("agent_not_running");
    if (!await setAgentStatus(database, ownerId, agentId, "active")) throw new Error("agent_missing");
    await syncEgress(() => syncAgentEgress(database, ownerId, agentId));
    return { ready: true };
  } catch (error) {
    return { ready: false, code: desktopCode(error, "desktop_setup_failed") };
  }
}

export async function createAgentForOwner(
  database: Database, ownerId: string, input: AgentCreateInput, desktop: DesktopOperations = defaultDesktop,
) {
  const agentId = randomUUID();
  await createAgentIdentity(database, ownerId, input, agentId);
  const result = await provisionAgentForOwner(database, ownerId, agentId, desktop);
  return { agentId, desktopReady: result.ready };
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

// Desktop controls are independent of the agent's active/paused status. Starting one requires the same safety gates as
// a run (active agent, running crew, no security stop, budget available) but never clears attention or resumes the crew.
async function requireDesktopStart(
  transaction: Transaction, ownerId: string, agent: AgentIdentity,
  budgetStatus: typeof readBudgetStatus,
) {
  if (agent.status !== "active") throw new AgentLifecycleError("agent_paused");
  const crew = await transaction.select({ crewStoppedAt: owner.crewStoppedAt }).from(owner).where(eq(owner.id, ownerId)).limit(1);
  if (crew[0]?.crewStoppedAt) throw new AgentLifecycleError("crew_stopped");
  const budget = await budgetStatus(transaction, ownerId, agent.id, new Date());
  if (budget.state === "paused") throw new AgentLifecycleError("budget_exhausted");
  if (budget.attention === "security_stop") throw new AgentLifecycleError("security_stopped");
}

async function desktopLifecycle(
  database: Database, ownerId: string, agentId: string, operation: "desktop.start" | "desktop.stop" | "browser.start" | "browser.stop",
  desktop: DesktopOperations, budgetStatus: typeof readBudgetStatus,
) {
  await withLockedAgent(database, ownerId, agentId, async (transaction, agent) => {
    if (operation === "desktop.start" || operation === "browser.start") await requireDesktopStart(transaction, ownerId, agent, budgetStatus);
    try {
      if (operation === "desktop.start" || operation === "browser.start") await desktop.desktopCreateAgent(agentId, ownerId);
      const status = await desktop.desktopSession(agentId, ownerId, operation);
      if (status.state !== "running" || !status.generation) throw new AgentLifecycleError(operation === "browser.start" ? "browser_start_failed" : "desktop_start_failed");
      if ((operation === "desktop.start" || operation === "browser.start") && (status.graphics !== "running" || status.browser !== "running"))
        throw new AgentLifecycleError(operation === "browser.start" || status.graphics === "running" ? "browser_start_failed" : "desktop_start_failed");
    } catch (error) {
      if (error instanceof AgentLifecycleError) throw error;
      throw new AgentLifecycleError(desktopCode(error, operation === "desktop.stop" ? "desktop_stop_failed" : operation === "browser.stop" ? "browser_stop_failed" : operation === "browser.start" ? "browser_start_failed" : "desktop_start_failed"));
    }
  });
  if (operation === "desktop.start" || operation === "browser.start") await syncEgress(() => syncAgentEgress(database, ownerId, agentId));
}

export async function startDesktopForOwner(database: Database, ownerId: string, agentId: string, desktop: DesktopOperations = defaultDesktop,
  budgetStatus: typeof readBudgetStatus = readBudgetStatus) {
  await desktopLifecycle(database, ownerId, agentId, "desktop.start", desktop, budgetStatus);
}

export async function stopDesktopForOwner(database: Database, ownerId: string, agentId: string, desktop: DesktopOperations = defaultDesktop) {
  await desktopLifecycle(database, ownerId, agentId, "desktop.stop", desktop, readBudgetStatus);
}

export async function startBrowserForOwner(database: Database, ownerId: string, agentId: string, desktop: DesktopOperations = defaultDesktop,
  budgetStatus: typeof readBudgetStatus = readBudgetStatus) {
  await desktopLifecycle(database, ownerId, agentId, "browser.start", desktop, budgetStatus);
}

export async function stopBrowserForOwner(database: Database, ownerId: string, agentId: string, desktop: DesktopOperations = defaultDesktop) {
  await desktopLifecycle(database, ownerId, agentId, "browser.stop", desktop, readBudgetStatus);
}

export async function desktopStatusForOwner(database: Database, ownerId: string, agentId: string, desktop: DesktopOperations = defaultDesktop) {
  const agent = await getAgentRecord(database, ownerId, agentId);
  if (!agent) throw new AgentLifecycleError("agent_not_found");
  try { return await desktop.desktopSession(agentId, ownerId, "session.status"); }
  catch { throw new AgentLifecycleError("desktop_unavailable"); }
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
