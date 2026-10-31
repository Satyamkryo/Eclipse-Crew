import "server-only";
import { getDatabase } from "../../db/client";
import { RequestError } from "../auth/request";
import { getAgentRecord } from "./data";

export async function requireOwnedAgent(ownerId: string, agentId: string) {
  const agent = await getAgentRecord(await getDatabase(), ownerId, agentId);
  if (!agent) throw new RequestError(404, "agent_not_found");
  return agent;
}
