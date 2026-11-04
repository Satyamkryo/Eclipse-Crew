import "server-only";

import { z } from "zod";

import { owner } from "../../db/schema";
import { getAgentRecord, listAgentRecords } from "../agents/data";
import { requireEgressProxySecret } from "../config/server";
import { EGRESS_PROXY_URL } from "../providers/proxy-transport";
import { listCanaryHashes } from "../security/canary-store";
import { loadAgentCredentials, pushAgentCredentials } from "../connections/proxy-credentials";
import { credentialsVersion } from "../connections/version";
import type { getDatabase } from "../../db/client";

// TASK-045. The proxy is memory-only and fails closed; `app` pushes each agent's allowlist over the
// private network. A failed push never fails the caller: the 60 s loop retries.
// TASK-047. The same push carries the agent's canary hashes and can trip or clear a tripped agent.

type Database = Awaited<ReturnType<typeof getDatabase>>;

export interface AgentEgressPolicy {
  agentId: string;
  domains: string[];
  // ADR-036. Any public website; the proxy still refuses internal, LAN and metadata addresses.
  anyPublic?: boolean;
  blocked: boolean;
  canaryHashes?: string[];
  trip?: boolean;
  clearTrip?: boolean;
}

export interface PushDependencies {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  secret?: string;
  timeoutMs?: number;
}

interface PolicyPushResult {
  ok: boolean;
  credentialsVersion: string | null;
}

export async function pushAgentPolicy(policy: AgentEgressPolicy, dependencies: PushDependencies = {}): Promise<boolean> {
  return (await pushAgentPolicyDetailed(policy, dependencies)).ok;
}

async function pushAgentPolicyDetailed(policy: AgentEgressPolicy, dependencies: PushDependencies = {}): Promise<PolicyPushResult> {
  let secret: string;
  try { secret = requireEgressProxySecret(dependencies.secret ?? process.env.EGRESS_PROXY_SECRET); } catch { return { ok: false, credentialsVersion: null }; }
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
        ...(policy.anyPublic ? { anyPublic: true } : {}),
        blocked: policy.blocked,
        ...(policy.canaryHashes ? { canaryHashes: policy.canaryHashes } : {}),
        ...(policy.trip ? { trip: true } : {}),
        ...(policy.clearTrip ? { clearTrip: true } : {}),
      }),
    });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* the body is not needed */ }
      return { ok: false, credentialsVersion: null };
    }
    let credentialsVersionValue: string | null = null;
    try {
      const body = await response.json() as { credentialsVersion?: unknown };
      if (typeof body.credentialsVersion === "string" && /^[0-9a-f]{64}$/.test(body.credentialsVersion)) {
        credentialsVersionValue = body.credentialsVersion;
      }
    } catch { /* the policy push still succeeded */ }
    return { ok: true, credentialsVersion: credentialsVersionValue };
  } catch { return { ok: false, credentialsVersion: null }; }
}

export async function syncAgentEgress(database: Database, ownerId: string, agentId: string): Promise<boolean> {
  const agent = await getAgentRecord(database, ownerId, agentId);
  const canaryHashes = await listCanaryHashes(database, ownerId, agentId).catch(() => []);
  if (!agent) return pushAgentPolicy({ agentId, domains: [], blocked: true, canaryHashes });
  const result = await pushAgentPolicyDetailed({ agentId, domains: agent.domains, anyPublic: agent.anyPublicWeb, blocked: agent.status !== "active", canaryHashes });
  // TASK-070. The proxy remembers a version hash; only a different one needs a credential push. A paused agent never
  // gets credentials pushed, and its entries were already dropped by the proxy when it was blocked.
  if (result.ok && agent.status === "active") {
    try {
      const entries = await loadAgentCredentials(database, ownerId, agentId);
      const localVersion = entries.length ? credentialsVersion(entries) : null;
      if (localVersion !== result.credentialsVersion) await pushAgentCredentials(database, ownerId, agentId);
    } catch { /* the next 60 s loop retries; no credential means no injection */ }
  }
  return result.ok;
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
  return pushAgentPolicy({ agentId, domains: agent?.domains ?? [], anyPublic: agent?.anyPublicWeb === true, blocked: agent ? agent.status !== "active" : true, canaryHashes, clearTrip: true });
}

// TASK-073c. Blocked-push controls are app-only and use the same proxy secret as policy pushes.
// A failed control call is returned as a failure: the step loop stops instead of guessing that an
// approval was issued or cleared.
export type PushKind = "default_branch" | "delete" | "tag_update";
export interface PushPending {
  id: string;
  site: string;
  actionClass: "post" | "delete";
  controlName: string;
  ref: string;
  kind: PushKind;
  owner: string;
  repo: string;
  requestHash: string;
  expiresAt: string;
}

const PENDING_SCHEMA = z.object({
  id: z.string().uuid(),
  site: z.string().min(1).max(300),
  actionClass: z.enum(["post", "delete"]),
  controlName: z.string().min(1).max(120),
  ref: z.string().min(1).max(300),
  kind: z.enum(["default_branch", "delete", "tag_update"]),
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  expiresAt: z.string().min(1).max(40),
}).strict();
const PENDING_LIST = z.object({ pending: z.array(PENDING_SCHEMA).max(8) }).strict();
const GRANT_RESULT = z.object({ grant: z.object({ id: z.string().uuid(), expiresAt: z.string().min(1).max(40) }).strict() }).strict();
const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SITE = /^github\.com\/[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const ACTION_CLASS = /^(post|delete)$/;

async function approvalControl(
  path: string, init: RequestInit, dependencies: PushDependencies,
): Promise<Response | null> {
  let secret: string;
  try { secret = requireEgressProxySecret(dependencies.secret ?? process.env.EGRESS_PROXY_SECRET); } catch { return null; }
  const send = dependencies.fetchImpl ?? fetch;
  try {
    const response = await send(`${dependencies.baseUrl ?? EGRESS_PROXY_URL}${path}`, {
      ...init,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(dependencies.timeoutMs ?? 5_000),
      headers: { Authorization: `Bearer ${secret}`, ...(init.headers ?? {}) },
    });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* the body is not needed */ }
      return null;
    }
    return response;
  } catch { return null; }
}

export async function fetchPushPending(agentId: string, dependencies: PushDependencies = {}): Promise<PushPending[] | null> {
  if (!AGENT_ID.test(agentId)) return null;
  const response = await approvalControl(`/v1/pending?agentId=${encodeURIComponent(agentId)}`, { method: "GET" }, dependencies);
  if (!response) return null;
  try {
    const parsed = PENDING_LIST.safeParse(await response.json());
    return parsed.success ? parsed.data.pending : null;
  } catch { return null; }
}

export async function grantPush(agentId: string, pendingId: string, dependencies: PushDependencies = {}): Promise<boolean> {
  if (!AGENT_ID.test(agentId) || !AGENT_ID.test(pendingId)) return false;
  const response = await approvalControl("/v1/grants", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId, pendingId }),
  }, dependencies);
  if (!response) return false;
  try { return GRANT_RESULT.safeParse(await response.json()).success; } catch { return false; }
}

export async function denyPush(agentId: string, pendingId: string, dependencies: PushDependencies = {}): Promise<boolean> {
  if (!AGENT_ID.test(agentId) || !AGENT_ID.test(pendingId)) return false;
  return Boolean(await approvalControl(`/v1/pending/${encodeURIComponent(pendingId)}?agentId=${encodeURIComponent(agentId)}`,
    { method: "DELETE" }, dependencies));
}

export async function clearPushApprovals(agentId: string, dependencies: PushDependencies = {}): Promise<boolean> {
  if (!AGENT_ID.test(agentId)) return false;
  return Boolean(await approvalControl(`/v1/git-approvals?agentId=${encodeURIComponent(agentId)}`, { method: "DELETE" }, dependencies));
}

export async function revokePushGrants(
  agentId: string, site: string, actionClass: string, dependencies: PushDependencies = {},
): Promise<boolean> {
  if (!AGENT_ID.test(agentId) || !SITE.test(site) || !ACTION_CLASS.test(actionClass)) return false;
  const query = `agentId=${encodeURIComponent(agentId)}&site=${encodeURIComponent(site)}&actionClass=${encodeURIComponent(actionClass)}`;
  return Boolean(await approvalControl(`/v1/grants?${query}`, { method: "DELETE" }, dependencies));
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
