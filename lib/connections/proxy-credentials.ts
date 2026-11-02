import "server-only";

import { and, eq } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { agentPolicies, composioKeys } from "../../db/schema";
import { requireEgressProxySecret } from "../config/server";
import { EGRESS_PROXY_URL } from "../providers/proxy-transport";
import { decryptSecret } from "../security/encryption";
import { listConnections } from "./data";
import type { CredentialEntry } from "./version";

type Database = Awaited<ReturnType<typeof getDatabase>>;

interface PushDependencies {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  secret?: string;
  timeoutMs?: number;
  // TASK-075. The OAuth link flow happens before the agent is granted `composio`, so that one call may include the key.
  includeComposio?: boolean;
}

// TASK-070. The token exists in plaintext only inside this function and in the proxy's memory.
export async function loadAgentCredentials(
  database: Database, ownerId: string, agentId: string, options: { includeComposio?: boolean } = {},
): Promise<CredentialEntry[]> {
  const rows = await listConnections(database, ownerId, agentId);
  const entries: CredentialEntry[] = [];
  for (const row of rows) {
    let token: string;
    try { token = decryptSecret(row.encryptedToken); } catch { continue; }
    for (const binding of row.bindings) {
      entries.push({
        host: binding.host,
        scheme: binding.scheme,
        header: binding.header ?? null,
        username: binding.username ?? null,
        token,
      });
    }
  }
  // TASK-075. The owner-level Composio key is injected for an agent only when that agent is granted `composio`.
  const policy = await database.select({ tools: agentPolicies.tools }).from(agentPolicies)
    .where(and(eq(agentPolicies.ownerId, ownerId), eq(agentPolicies.agentId, agentId))).limit(1);
  if (options.includeComposio || policy[0]?.tools.includes("composio")) {
    const keys = await database.select({ encryptedKey: composioKeys.encryptedKey }).from(composioKeys)
      .where(eq(composioKeys.ownerId, ownerId)).limit(1);
    if (keys[0]?.encryptedKey) {
      try {
        entries.push({
          host: "backend.composio.dev", scheme: "header", header: "x-api-key", username: null,
          token: decryptSecret(keys[0].encryptedKey),
        });
      } catch { /* an unreadable key means no injection */ }
    }
  }
  return entries.slice(0, 32);
}

export async function pushAgentCredentials(
  database: Database, ownerId: string, agentId: string, dependencies: PushDependencies = {},
): Promise<boolean> {
  let secret: string;
  try { secret = requireEgressProxySecret(dependencies.secret ?? process.env.EGRESS_PROXY_SECRET); } catch { return false; }
  const entries = await loadAgentCredentials(database, ownerId, agentId, { includeComposio: dependencies.includeComposio === true });
  const send = dependencies.fetchImpl ?? fetch;
  try {
    const response = await send(`${dependencies.baseUrl ?? EGRESS_PROXY_URL}/v1/credentials`, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(dependencies.timeoutMs ?? 5_000),
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, credentials: entries }),
    });
    try { await response.body?.cancel(); } catch { /* the body is not needed */ }
    return response.ok;
  } catch { return false; }
}
