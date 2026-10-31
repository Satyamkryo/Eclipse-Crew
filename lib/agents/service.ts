import "server-only";
import { randomUUID } from "node:crypto";
import { getDatabase } from "../../db/client";
import { desktopCreateAgent, desktopDeleteAgent, desktopSession } from "../desktop/client";
import { createAgentRecord, deleteAgentRecord, getAgentIdentity, setAgentStatus, updateAgentRecord } from "./data";
import type { AgentCreateInput, AgentUpdateInput } from "./schema";

type Database = Awaited<ReturnType<typeof getDatabase>>;

export class AgentLifecycleError extends Error {
  constructor(public code: "agent_not_found" | "confirmation_mismatch" | "desktop_setup_failed") {
    super(code);
  }
}

export async function createAgentForOwner(database: Database, ownerId: string, input: AgentCreateInput) {
  const agentId = randomUUID();
  await createAgentRecord(database, ownerId, input, agentId);
  try {
    await desktopCreateAgent(agentId, ownerId);
    const status = await desktopSession(agentId, ownerId, "session.start");
    if (status.state !== "running" || !status.generation) throw new Error("agent_not_running");
    await setAgentStatus(database, ownerId, agentId, "active");
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
}

export async function pauseAgentForOwner(database: Database, ownerId: string, agentId: string) {
  await requireAgent(database, ownerId, agentId);
  await desktopSession(agentId, ownerId, "session.stop");
  await setAgentStatus(database, ownerId, agentId, "paused");
}

export async function resumeAgentForOwner(database: Database, ownerId: string, agentId: string) {
  await requireAgent(database, ownerId, agentId);  try {
    await desktopCreateAgent(agentId, ownerId);
    const status = await desktopSession(agentId, ownerId, "session.start");
    if (status.state !== "running" || !status.generation) throw new Error("agent_not_running");
    await setAgentStatus(database, ownerId, agentId, "active");
  } catch {
    throw new AgentLifecycleError("desktop_setup_failed");
  }
}

export async function deleteAgentForOwner(
  database: Database, ownerId: string, agentId: string, confirmation: string,
) {
  const agent = await requireAgent(database, ownerId, agentId);
  if (agent.name !== confirmation) throw new AgentLifecycleError("confirmation_mismatch");
  await desktopDeleteAgent(agentId, ownerId);
  await deleteAgentRecord(database, ownerId, agentId);
}

async function requireAgent(database: Database, ownerId: string, agentId: string) {
  const agent = await getAgentIdentity(database, ownerId, agentId);
  if (!agent) throw new AgentLifecycleError("agent_not_found");
  return agent;
}
