import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, lt, lte } from "drizzle-orm";
import { z } from "zod";

import type { getDatabase } from "../../db/client";
import { connections, githubDeviceFlows } from "../../db/schema";
import { getAgentIdentity } from "../agents/data";
import { requireEgressProxySecret } from "../config/server";
import { EGRESS_PROXY_URL } from "../providers/proxy-transport";
import { recordAudit, type AuditExecutor } from "../security/audit";
import { decryptSecret, encryptSecret } from "../security/encryption";
import { keyHint } from "../security/key-hint";
import {
  countAgentConnections, findConnectionByLabel, getConnection, insertConnection, updateConnection,
  type StoredConnection,
} from "./data";
import { ConnectionError } from "./errors";
import { presetBindings } from "./presets";
import { pushAgentCredentials } from "./proxy-credentials";
import { MAX_CONNECTIONS_PER_AGENT } from "./service";
import { enqueueConnectionRefresh, enqueueDevicePoll } from "./device-queue";
import { githubInstallUrl } from "./slug";

type Database = Awaited<ReturnType<typeof getDatabase>>;
type FlowRow = typeof githubDeviceFlows.$inferSelect;

const CLIENT_ID = /^[A-Za-z0-9._-]{1,64}$/;
const DEVICE_CODE = /^[A-Za-z0-9._-]{8,256}$/;
const TOKEN = /^[\x21-\x7e]{8,4096}$/;
const REFRESH_AHEAD_MS = 30 * 60_000;
const MAX_FLOW_MS = 15 * 60_000;

export const startGithubDeviceSchema = z.object({
  agentId: z.string().uuid(),
  label: z.string().trim().min(1).max(60).optional(),
}).strict();

export type GithubDeviceDependencies = {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  secret?: string;
  now?: () => Date;
  // Injected by tests so a unit run never needs pg-boss, the proxy or the network.
  enqueuePoll?: typeof enqueueDevicePoll;
  enqueueRefresh?: typeof enqueueConnectionRefresh;
  pushCredentials?: typeof pushAgentCredentials;
};

export type DeviceFlowView = {
  id: string;
  status: "pending" | "connected" | "expired" | "denied" | "error";
  userCode: string;
  verificationUri: string;
  installUrl: string;
  expiresAt: string;
  error: string | null;
  connectionId: string | null;
};

function clientId(): string {
  const value = process.env.GITHUB_APP_CLIENT_ID ?? "";
  if (!CLIENT_ID.test(value)) throw new ConnectionError("github_app_not_configured", 503);
  return value;
}
type DeviceResponse =
  | { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number }
  | { access_token: string; token_type: string; scope: string; refresh_token: string | null;
      expires_in: number | null; refresh_token_expires_in: number | null }
  | { error: string; error_description?: string | null };

async function callProxy(body: Record<string, unknown>, dependencies: GithubDeviceDependencies): Promise<DeviceResponse> {
  let secret: string;
  try { secret = requireEgressProxySecret(dependencies.secret ?? process.env.EGRESS_PROXY_SECRET); }
  catch { throw new ConnectionError("egress_unavailable", 503); }
  const send = dependencies.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await send(`${dependencies.baseUrl ?? EGRESS_PROXY_URL}/v1/github-device`, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, clientId: clientId() }),
    });
  } catch { throw new ConnectionError("github_unreachable", 503); }
  if (!response.ok) throw new ConnectionError(response.status === 400 ? "invalid_device_request" : "github_unreachable", 503);
  try {
    const value = await response.json() as DeviceResponse;
    if (!value || typeof value !== "object") throw new Error();
    return value;
  } catch { throw new ConnectionError("github_unreachable", 503); }
}

function view(row: FlowRow): DeviceFlowView {
  return {
    id: row.id,
    status: row.status as DeviceFlowView["status"],
    userCode: row.userCode,
    verificationUri: row.verificationUri,
    installUrl: githubInstallUrl(),
    expiresAt: row.expiresAt.toISOString(),
    error: row.errorCode,
    connectionId: row.connectionId,
  };
}

// A GitHub App token looks like `ghu_...`. Keep only the family and the last four characters.
function tokenHint(token: string): string {
  if (token.startsWith("ghu_")) return `ghu_…${token.slice(-4)}`;
  return keyHint(token);
}

async function findFlow(database: Pick<Database, "select">, flowId: string): Promise<FlowRow | undefined> {
  const rows = await database.select().from(githubDeviceFlows).where(eq(githubDeviceFlows.id, flowId)).limit(1);
  return rows[0];
}

async function findFlowForOwner(database: Pick<Database, "select">, ownerId: string, flowId: string): Promise<FlowRow | undefined> {
  const rows = await database.select().from(githubDeviceFlows)
    .where(and(eq(githubDeviceFlows.ownerId, ownerId), eq(githubDeviceFlows.id, flowId))).limit(1);
  return rows[0];
}

async function markFlowExpired(database: Database, row: FlowRow, code: string): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction.update(githubDeviceFlows).set({ status: code === "access_denied" ? "denied" : "expired", errorCode: code, updatedAt: new Date() })
      .where(and(eq(githubDeviceFlows.id, row.id), eq(githubDeviceFlows.status, "pending")));
    await recordAudit(transaction as unknown as AuditExecutor, row.ownerId, {
      kind: "connection_device_expired", agentId: row.agentId, code,
    });
  }).catch(() => undefined);
}

// Starts a sign-in. The device code is encrypted before it reaches the database and is never returned to the UI.
export async function startGithubDevice(
  database: Database, ownerId: string, input: unknown, dependencies: GithubDeviceDependencies = {},
): Promise<DeviceFlowView> {
  const parsed = startGithubDeviceSchema.safeParse(input);
  if (!parsed.success) throw new ConnectionError("invalid_input");
  const agent = await getAgentIdentity(database, ownerId, parsed.data.agentId);
  if (!agent) throw new ConnectionError("not_found", 404);
  if (agent.status !== "active") throw new ConnectionError("agent_inactive", 409);
  if (await countAgentConnections(database, ownerId, agent.id) >= MAX_CONNECTIONS_PER_AGENT &&
      !(await findConnectionByLabel(database, ownerId, agent.id, parsed.data.label ?? "GitHub"))) {
    throw new ConnectionError("connection_limit", 409);
  }
  const label = parsed.data.label ?? "GitHub";
  const existing = await findConnectionByLabel(database, ownerId, agent.id, label);
  if (existing && existing.source !== "github_app") throw new ConnectionError("label_taken", 409);

  const now = (dependencies.now ?? (() => new Date()))();
  const code = await callProxy({ operation: "code" }, dependencies);
  if (!("device_code" in code) || !DEVICE_CODE.test(code.device_code)) throw new ConnectionError("github_unreachable", 503);
  const expiresAt = new Date(Math.min(now.getTime() + code.expires_in * 1000, now.getTime() + MAX_FLOW_MS));
  const row: FlowRow = {
    id: randomUUID(), ownerId, agentId: agent.id, label,
    encryptedDeviceCode: encryptSecret(code.device_code), userCode: code.user_code,
    verificationUri: code.verification_uri, intervalSeconds: code.interval,
    status: "pending", errorCode: null, connectionId: null, expiresAt,
    createdAt: now, updatedAt: now,
  };
  try {
    await database.transaction(async (transaction) => {
      await transaction.update(githubDeviceFlows)
        .set({ status: "expired", errorCode: "replaced", updatedAt: now })
        .where(and(eq(githubDeviceFlows.ownerId, ownerId), eq(githubDeviceFlows.agentId, agent.id), eq(githubDeviceFlows.status, "pending")));
      await transaction.insert(githubDeviceFlows).values(row);
      await recordAudit(transaction as unknown as AuditExecutor, ownerId, {
        kind: "connection_device_started", agentId: agent.id, code: "github_app",
      });
    });
  } catch {
    throw new ConnectionError("github_unreachable", 503);
  }
  await (dependencies.enqueuePoll ?? enqueueDevicePoll)(row.id, row.intervalSeconds).catch(() => false);
  return view(row);
}

export async function getGithubDeviceFlow(
  database: Database, ownerId: string, flowId: string, dependencies: GithubDeviceDependencies = {},
): Promise<DeviceFlowView> {
  const row = await findFlowForOwner(database, ownerId, flowId);
  if (!row) throw new ConnectionError("not_found", 404);
  const now = (dependencies.now ?? (() => new Date()))();
  if (row.status === "pending" && row.expiresAt.getTime() <= now.getTime()) {
    await markFlowExpired(database, row, "expired_token");
    const fresh = await findFlowForOwner(database, ownerId, flowId);
    return view(fresh ?? row);
  }
  return view(row);
}

async function connectFlow(database: Database, row: FlowRow, token: {
  access_token: string; refresh_token: string | null; expires_in: number | null; refresh_token_expires_in: number | null;
}, dependencies: GithubDeviceDependencies): Promise<{ connectionId: string }> {
  const now = (dependencies.now ?? (() => new Date()))();
  const tokenExpiresAt = token.expires_in ? new Date(now.getTime() + token.expires_in * 1000) : null;
  const refreshExpiresAt = token.refresh_token && token.refresh_token_expires_in
    ? new Date(now.getTime() + token.refresh_token_expires_in * 1000) : null;
  const bindings = presetBindings("github", undefined);
  const secrets = {
    encryptedToken: encryptSecret(token.access_token),
    tokenHint: tokenHint(token.access_token),
    encryptedRefreshToken: token.refresh_token ? encryptSecret(token.refresh_token) : null,
    tokenExpiresAt, refreshExpiresAt, source: "github_app" as const, status: "active" as const,
  };
  const existing = await findConnectionByLabel(database, row.ownerId, row.agentId, row.label);
  const connectionId = existing?.source === "github_app" ? existing.id : randomUUID();
  await database.transaction(async (transaction) => {
    if (existing?.source === "github_app") {
      await updateConnection(transaction, row.ownerId, existing.id, secrets);
    } else {
      await insertConnection(transaction, {
        id: connectionId, ownerId: row.ownerId, agentId: row.agentId, preset: "github", label: row.label,
        bindings, ...secrets, createdAt: now, updatedAt: now,
      });
    }
    await transaction.update(githubDeviceFlows).set({ status: "connected", errorCode: null, connectionId, updatedAt: now })
      .where(and(eq(githubDeviceFlows.id, row.id), eq(githubDeviceFlows.status, "pending")));
    await recordAudit(transaction as unknown as AuditExecutor, row.ownerId, {
      kind: "connection_device_connected", agentId: row.agentId, code: "github_app",
    });
  });
  await (dependencies.pushCredentials ?? pushAgentCredentials)(database, row.ownerId, row.agentId).catch(() => false);
  return { connectionId };
}

export type PollResult = { delay?: number; intervalSeconds?: number; done?: boolean };

// Called by the poll worker. A pending, slow_down or success answer tells the worker when to try again; every
// terminal answer is recorded once and never retried.
export async function pollGithubDevice(
  database: Database, flowId: string, dependencies: GithubDeviceDependencies = {},
): Promise<PollResult> {
  const row = await findFlow(database, flowId);
  if (!row || row.status !== "pending") return { done: true };
  const now = (dependencies.now ?? (() => new Date()))();
  if (row.expiresAt.getTime() <= now.getTime()) { await markFlowExpired(database, row, "expired_token"); return { done: true }; }

  let deviceCode: string;
  try { deviceCode = decryptSecret(row.encryptedDeviceCode); } catch { await markFlowExpired(database, row, "invalid_device_code"); return { done: true }; }
  const result = await callProxy({ operation: "token", deviceCode }, dependencies);

  if ("error" in result) {
    if (result.error === "authorization_pending") return { delay: row.intervalSeconds };
    if (result.error === "slow_down") {
      const intervalSeconds = Math.min(row.intervalSeconds + 5, 60);
      await database.update(githubDeviceFlows).set({ intervalSeconds, updatedAt: now }).where(eq(githubDeviceFlows.id, row.id));
      return { delay: intervalSeconds, intervalSeconds };
    }
    if (result.error === "access_denied") { await markFlowExpired(database, row, "access_denied"); return { done: true }; }
    if (result.error === "expired_token") { await markFlowExpired(database, row, "expired_token"); return { done: true }; }
    await markFlowExpired(database, row, result.error);
    return { done: true };
  }
  if (!("access_token" in result) || !TOKEN.test(result.access_token)) {
    await markFlowExpired(database, row, "invalid_device_response");
    return { done: true };
  }
  await connectFlow(database, row, result, dependencies);
  return { done: true };
}

export type RefreshResult = { retry?: boolean; done?: boolean };

async function markConnectionExpired(database: Database, row: StoredConnection, code: string, dependencies: GithubDeviceDependencies = {}): Promise<void> {
  await database.transaction(async (transaction) => {
    await updateConnection(transaction, row.ownerId, row.id, { status: "expired", encryptedRefreshToken: null });
    await recordAudit(transaction as unknown as AuditExecutor, row.ownerId, {
      kind: "connection_device_expired", agentId: row.agentId, code,
    });
  }).catch(() => undefined);
  await (dependencies.pushCredentials ?? pushAgentCredentials)(database, row.ownerId, row.agentId).catch(() => false);
}

// Refreshes 30 minutes before expiry. A rejected or missing refresh token marks the connection expired; a
// network failure is retried by the queue and never destroys the token.
export async function refreshGithubConnection(
  database: Database, ownerId: string, connectionId: string, dependencies: GithubDeviceDependencies = {},
): Promise<RefreshResult> {
  const row = await getConnection(database, ownerId, connectionId);
  if (!row || row.source !== "github_app" || row.status !== "active") return { done: true };
  const now = (dependencies.now ?? (() => new Date()))();
  if (row.refreshExpiresAt && row.refreshExpiresAt.getTime() <= now.getTime()) {
    await markConnectionExpired(database, row, "refresh_expired", dependencies);
    return { done: true };
  }
  if (!row.encryptedRefreshToken) {
    if (row.tokenExpiresAt && row.tokenExpiresAt.getTime() <= now.getTime()) await markConnectionExpired(database, row, "refresh_missing", dependencies);
    return { done: true };
  }
  let refreshToken: string;
  try { refreshToken = decryptSecret(row.encryptedRefreshToken); } catch { await markConnectionExpired(database, row, "refresh_unreadable", dependencies); return { done: true }; }
  let result: DeviceResponse;
  try { result = await callProxy({ operation: "token", refreshToken }, dependencies); }
  catch (error) {
    // A transport failure is retryable; the stored token may still be valid.
    if (error instanceof ConnectionError && error.status === 503) return { retry: true };
    throw error;
  }
  if ("error" in result) {
    if (["bad_refresh_token", "expired_token", "access_denied", "incorrect_client_credentials", "unsupported_grant_type"].includes(result.error)) {
      await markConnectionExpired(database, row, result.error, dependencies);
      return { done: true };
    }
    return { retry: true };
  }
  if (!("access_token" in result) || !TOKEN.test(result.access_token)) { await markConnectionExpired(database, row, "invalid_device_response", dependencies); return { done: true }; }
  const tokenExpiresAt = result.expires_in ? new Date(now.getTime() + result.expires_in * 1000) : null;
  const refreshExpiresAt = result.refresh_token && result.refresh_token_expires_in
    ? new Date(now.getTime() + result.refresh_token_expires_in * 1000) : row.refreshExpiresAt;
  await database.transaction(async (transaction) => {
    await updateConnection(transaction, ownerId, connectionId, {
      encryptedToken: encryptSecret(result.access_token), tokenHint: tokenHint(result.access_token),
      encryptedRefreshToken: result.refresh_token ? encryptSecret(result.refresh_token) : row.encryptedRefreshToken,
      tokenExpiresAt, refreshExpiresAt, status: "active",
    });
    await recordAudit(transaction as unknown as AuditExecutor, ownerId, {
      kind: "connection_replaced", agentId: row.agentId, code: "github_app_refresh",
    });
  });
  await (dependencies.pushCredentials ?? pushAgentCredentials)(database, ownerId, row.agentId).catch(() => false);
  return { done: true };
}

// Clears pending flows whose worker was lost. Called by the scheduler tick; a stale pending row is expired once.
export async function expireStaleFlows(database: Database, now = new Date()): Promise<void> {
  const rows = await database.select().from(githubDeviceFlows)
    .where(and(eq(githubDeviceFlows.status, "pending"), lt(githubDeviceFlows.expiresAt, now))).limit(50);
  for (const row of rows) await markFlowExpired(database, row, "expired_token");
}

// The scheduler tick refreshes a GitHub App token 30 minutes before it expires. The queue dedupes per connection,
// and the tick retries next minute after a transient failure, so a refresh never has to enqueue from inside itself.
export async function refreshDueConnections(
  database: Database, now = new Date(), dependencies: GithubDeviceDependencies = {},
): Promise<number> {
  const due = await database.select({ id: connections.id, ownerId: connections.ownerId })
    .from(connections)
    .where(and(
      eq(connections.source, "github_app"),
      eq(connections.status, "active"),
      isNotNull(connections.tokenExpiresAt),
      lte(connections.tokenExpiresAt, new Date(now.getTime() + REFRESH_AHEAD_MS)),
    )).limit(50);
  let queued = 0;
  for (const row of due) {
    const sent = await (dependencies.enqueueRefresh ?? enqueueConnectionRefresh)(row.ownerId, row.id, 1).catch(() => false);
    if (sent) queued += 1;
  }
  return queued;
}
