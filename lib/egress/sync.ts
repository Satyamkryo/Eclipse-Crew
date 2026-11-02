import "server-only";

import { owner } from "../../db/schema";
import { getAgentRecord, listAgentRecords } from "../agents/data";
import { requireEgressProxySecret } from "../config/server";
import { EGRESS_PROXY_URL } from "../providers/proxy-transport";
import { listCanaryHashes } from "../security/canary-store";
import type { getDatabase } from "../../db/client";

// TASK-045. The proxy is memory-only and fails closed; `app` pushes each agent's allowlist over the
// private network. A failed push never fails the caller: the 60 s loop retries.
// TASK-047. The same push carries the agent's canary hashes and can trip or clear a tripped agent.

type Database = Awaited<ReturnType<typeof getDatabase>>;

export interface AgentEgressPolicy {
  agentId: string;
  domains: string[];
  blocked: boolean;
  canaryHashes?: string[];
  trip?: boolean;
  clearTrip?: boolean;
}

interface PushDependencies {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  secret?: string;
  timeoutMs?: number;
}

export async function pushAgentPolicy(policy: AgentEgressPolicy, dependencies: PushDependencies = {}): Promise<boolean> {
  let secret: string;
  try { secret = requireEgressProxySecret(dependencies.secret ?? process.env.EGRESS_PROXY_SECRET); } catch { return false; }
  const send = dependencies.fetchImpl ?? fetch;
  try {
    const response = await send(`${dependencies.baseUrl ?? EGRESS_PROXY_URL}/v1/policy`, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(dependencies.timeoutMs ?? 5_000),
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: policy.agentId,
        domains: policy.domains,
        blocked: policy.blocked,
        ...(policy.canaryHashes ? { canaryHashes: policy.canaryHashes } : {}),
        ...(policy.trip ? { trip: true } : {}),
        ...(policy.clearTrip ? { clearTrip: true } : {}),
      }),
    });
    try { await response.body?.cancel(); } catch { /* the body is not needed */ }
    return response.ok;
  } catch { return false; }
}

export async function syncAgentEgress(database: Database, ownerId: string, agentId: string): Promise<boolean> {
  const agent = await getAgentRecord(database, ownerId, agentId);
  const canaryHashes = await listCanaryHashes(database, ownerId, agentId).catch(() => []);
  if (!agent) return pushAgentPolicy({ agentId, domains: [], blocked: true, canaryHashes });
  return pushAgentPolicy({ agentId, domains: agent.domains, blocked: agent.status !== "active", canaryHashes });
}

// TASK-047. Trip and resume pushes. A failed push is safe: the session stop and the proxy latch fail closed.
export async function tripAgent(database: Database, ownerId: string, agentId: string): Promise<boolean> {
  const agent = await getAgentRecord(database, ownerId, agentId);
  const canaryHashes = await listCanaryHashes(database, ownerId, agentId).catch(() => []);
  return pushAgentPolicy({ agentId, domains: agent?.domains ?? [], blocked: true, canaryHashes, trip: true });
}

export async function clearAgentTrip(database: Database, ownerId: string, agentId: string): Promise<boolean> {
  const agent = await getAgentRecord(database, ownerId, agentId);
  const canaryHashes = await listCanaryHashes(database, ownerId, agentId).catch(() => []);
  return pushAgentPolicy({ agentId, domains: agent?.domains ?? [], blocked: agent ? agent.status !== "active" : true, canaryHashes, clearTrip: true });
}

export async function syncAllAgents(database: Database): Promise<void> {
  const owners = await database.select({ id: owner.id }).from(owner);
  for (const row of owners) {
    const agents = await listAgentRecords(database, row.id);
    for (const item of agents) {
      await syncAgentEgress(database, row.id, item.id);
    }
  }
}
