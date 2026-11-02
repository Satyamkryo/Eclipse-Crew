import "server-only";

import { randomUUID } from "node:crypto";

import type { getDatabase } from "../../db/client";
import { getAgentIdentity } from "../agents/data";
import { createToolTransport } from "../connections/transport";
import { pushAgentCredentials } from "../connections/proxy-credentials";
import { recordAudit, type AuditExecutor } from "../security/audit";
import { encryptSecret } from "../security/encryption";
import { keyHint } from "../security/key-hint";
import { createComposioClient, safeRedirectUrl, type ComposioClient } from "./client";
import {
  deleteComposioAccount, deleteComposioKey, getComposioAccount, getComposioAccountByToolkit, getComposioKey,
  insertComposioAccount, listComposioAccounts, updateComposioAccount, upsertComposioKey, type StoredComposioAccount,
} from "./data";
import { ComposioError } from "./errors";
import { composioToolsHash, livePinFromTools } from "./risk";
import {
  composioConnectSchema, composioKeySchema, composioPinSchema,
} from "./schema";
import { buildComposioSession } from "./session";

type Database = Awaited<ReturnType<typeof getDatabase>>;

import type { ComposioAccountView, ComposioDiscovery, ComposioKeyView } from "./view";
export type { ComposioAccountView, ComposioDiscovery, ComposioKeyView };

export function composioKeyView(key: Awaited<ReturnType<typeof getComposioKey>>): ComposioKeyView {
  return { hasKey: Boolean(key?.encryptedKey), keyHint: key?.keyHint ?? null, injectionCheck: key?.injectionCheck ?? false };
}

function accountView(row: StoredComposioAccount): ComposioAccountView {
  return {
    id: row.id, agentId: row.agentId, toolkit: row.toolkit, status: row.status,
    toolCount: row.tools.length, toolsHash: row.toolsHash, pinnedAt: row.pinnedAt?.toISOString() ?? null,
  };
}

async function requireKey(database: Database, ownerId: string) {
  const key = await getComposioKey(database, ownerId);
  if (!key?.encryptedKey) throw new ComposioError("composio_not_configured", 409);
  return key;
}

function clientFor(agentId: string, factory?: typeof createComposioClient) {
  if (factory) return (factory as unknown as (options: unknown) => ComposioClient)({ transport: null });
  return createComposioClient({ transport: createToolTransport({ agentId }) });
}

async function withSession<T>(client: ComposioClient, body: Record<string, unknown>, fn: (sessionId: string) => Promise<T>): Promise<T> {
  const sessionId = await client.createSession(body);
  try { return await fn(sessionId); }
  finally { await client.deleteSession(sessionId).catch(() => undefined); }
}

export async function readComposioKey(database: Database, ownerId: string): Promise<ComposioKeyView> {
  return composioKeyView(await getComposioKey(database, ownerId));
}

export async function saveComposioKey(database: Database, ownerId: string, input: unknown): Promise<ComposioKeyView> {
  const parsed = composioKeySchema.safeParse(input);
  if (!parsed.success) throw new ComposioError("invalid_input", 400);
  const existing = await getComposioKey(database, ownerId);
  const apiKey = parsed.data.apiKey || undefined;
  if (!apiKey && !existing?.encryptedKey) throw new ComposioError("key_required", 400);
  let secrets: { encryptedKey?: string; keyHint?: string } = {};
  if (apiKey) {
    try { secrets = { encryptedKey: encryptSecret(apiKey), keyHint: keyHint(apiKey) }; }
    catch { throw new ComposioError("encryption_unavailable", 503); }
  }
  await database.transaction(async (transaction) => {
    await upsertComposioKey(transaction, ownerId, {
      id: existing?.id ?? randomUUID(), ...secrets,
      ...(parsed.data.injectionCheck !== undefined ? { injectionCheck: parsed.data.injectionCheck } : {}),
    });
    await recordAudit(transaction as unknown as AuditExecutor, ownerId, {
      kind: "composio_key_saved", code: secrets.encryptedKey ? "key_saved" : "settings_changed",
    });
  });
  return readComposioKey(database, ownerId);
}

export async function removeComposioKey(database: Database, ownerId: string): Promise<ComposioKeyView> {
  await database.transaction(async (transaction) => {
    await deleteComposioKey(transaction, ownerId);
    for (const account of await listComposioAccounts(database, ownerId)) {
      await updateComposioAccount(transaction, ownerId, account.id, { status: "revoked" });
    }
    await recordAudit(transaction as unknown as AuditExecutor, ownerId, { kind: "composio_key_removed" });
  });
  await pushComposioKey(database, ownerId);
  return readComposioKey(database, ownerId);
}

async function pushComposioKey(database: Database, ownerId: string): Promise<void> {
  try {
    const accounts = await listComposioAccounts(database, ownerId);
    const agentIds = [...new Set(accounts.map((account) => account.agentId))];
    for (const agentId of agentIds) await pushAgentCredentials(database, ownerId, agentId, { includeComposio: true });
  } catch { /* the 60 s loop retries */ }
}

export async function listComposioAccountViews(database: Database, ownerId: string, agentId?: string): Promise<ComposioAccountView[]> {
  return (await listComposioAccounts(database, ownerId, agentId)).map(accountView);
}

function mapLinkError(error: unknown): never {
  if (!(error instanceof ComposioError)) throw error;
  if (error.status === 404) throw new ComposioError("managed_auth_unavailable", 409);
  if (error.status === 501) throw new ComposioError("link_unsupported", 409);
  if (error.status === 408) throw new ComposioError("link_timeout", 504);
  if (error.status === 401) throw new ComposioError("key_rejected", 401);
  throw error;
}

export async function connectComposioAccount(
  database: Database, ownerId: string, input: unknown, factory?: typeof createComposioClient,
): Promise<{ redirectUrl: string; account: ComposioAccountView }> {
  const parsed = composioConnectSchema.safeParse(input);
  if (!parsed.success) throw new ComposioError("invalid_input", 400);
  const { agentId, toolkit } = parsed.data;
  await requireKey(database, ownerId);
  const agent = await getAgentIdentity(database, ownerId, agentId);
  if (!agent) throw new ComposioError("not_found", 404);
  const existing = await getComposioAccountByToolkit(database, ownerId, agentId, toolkit);
  if (existing && ["pending", "active", "changed"].includes(existing.status)) throw new ComposioError("already_connected", 409);
  await pushAgentCredentials(database, ownerId, agentId, { includeComposio: true }).catch(() => false);

  const client = clientFor(agentId, factory);
  let link;
  try {
    link = await withSession(client, buildComposioSession({
      agentId, accounts: [], pinned: [], injectionCheck: false, toolkits: [toolkit],
    }), (sessionId) => client.createLink(sessionId, toolkit));
  } catch (error) { mapLinkError(error); }
  const redirectUrl = safeRedirectUrl(link.redirectUrl);
  if (!redirectUrl) throw new ComposioError("invalid_redirect", 502);

  const row: StoredComposioAccount = {
    id: randomUUID(), ownerId, agentId, toolkit, connectedAccountId: link.connectedAccountId,
    status: "pending", toolsHash: null, tools: [], pinnedAt: null, createdAt: new Date(),
  };
  await database.transaction(async (transaction) => {
    const current = await getComposioAccountByToolkit(transaction, ownerId, agentId, toolkit);
    if (current) {
      if (["pending", "active", "changed"].includes(current.status)) throw new ComposioError("already_connected", 409);
      if (!(await deleteComposioAccount(transaction, ownerId, current.id))) throw new ComposioError("already_connected", 409);
    }
    await insertComposioAccount(transaction, row);
    await recordAudit(transaction as unknown as AuditExecutor, ownerId, {
      kind: "composio_account_connected", agentId, code: toolkit,
    });
  });
  return { redirectUrl, account: accountView(row) };
}

function statusFromComposio(value: string): StoredComposioAccount["status"] {
  if (value === "ACTIVE") return "active";
  if (value === "FAILED" || value === "EXPIRED" || value === "INACTIVE") return "failed";
  return "pending";
}

async function refresh(database: Database, ownerId: string, account: StoredComposioAccount, factory?: typeof createComposioClient) {
  const key = await requireKey(database, ownerId);
  await pushAgentCredentials(database, ownerId, account.agentId, { includeComposio: true }).catch(() => false);
  const client = clientFor(account.agentId, factory);
  const accounts = account.connectedAccountId ? [{ toolkit: account.toolkit, connectedAccountId: account.connectedAccountId }] : [];
  const body = buildComposioSession({
    agentId: account.agentId, accounts, pinned: account.tools, injectionCheck: key.injectionCheck,
  });
  const state = await withSession(client, body, (sessionId) => client.toolkitStatus(sessionId, [account.toolkit]));
  return state.find((item) => item.slug === account.toolkit) ?? { slug: account.toolkit, status: "INITIALIZING", accountId: null };
}

export async function refreshComposioAccount(database: Database, ownerId: string, id: string, factory?: typeof createComposioClient): Promise<ComposioAccountView> {
  const account = await getComposioAccount(database, ownerId, id);
  if (!account) throw new ComposioError("not_found", 404);
  if (account.status === "revoked") throw new ComposioError("composio_not_connected", 409);
  const state = await refresh(database, ownerId, account, factory);
  const status = account.status === "changed" || (account.pinnedAt && account.status !== "pending")
    ? account.status : statusFromComposio(state.status);
  await updateComposioAccount(database, ownerId, id, { status });
  const updated = await getComposioAccount(database, ownerId, id);
  if (!updated) throw new ComposioError("not_found", 404);
  return accountView(updated);
}

async function discoverTools(database: Database, ownerId: string, account: StoredComposioAccount, factory?: typeof createComposioClient): Promise<ComposioDiscovery> {
  const key = await requireKey(database, ownerId);
  await pushAgentCredentials(database, ownerId, account.agentId, { includeComposio: true }).catch(() => false);
  const client = clientFor(account.agentId, factory);
  const accounts = account.connectedAccountId ? [{ toolkit: account.toolkit, connectedAccountId: account.connectedAccountId }] : [];
  const tools = await withSession(client, buildComposioSession({
    agentId: account.agentId, accounts, pinned: [], injectionCheck: key.injectionCheck,
  }), (sessionId) => client.listTools(sessionId));
  const { pinned, hash } = livePinFromTools(tools.filter((tool) => {
    const toolkit = tool.toolkit?.slug ?? tool.slug.split("_")[0].toLowerCase();
    return toolkit === account.toolkit;
  }));
  return { toolkit: account.toolkit, tools: pinned, toolsHash: hash };
}

export async function discoverComposioTools(database: Database, ownerId: string, id: string, factory?: typeof createComposioClient): Promise<ComposioDiscovery> {
  const account = await getComposioAccount(database, ownerId, id);
  if (!account) throw new ComposioError("not_found", 404);
  if (account.status === "revoked") throw new ComposioError("composio_not_connected", 409);
  return discoverTools(database, ownerId, account, factory);
}

export async function pinComposioAccount(
  database: Database, ownerId: string, id: string, input: unknown, factory?: typeof createComposioClient,
): Promise<{ kind: "discovery"; discovery: ComposioDiscovery } | { kind: "pinned"; account: ComposioAccountView }> {
  const parsed = composioPinSchema.safeParse(input);
  if (!parsed.success) throw new ComposioError("invalid_input", 400);
  const account = await getComposioAccount(database, ownerId, id);
  if (!account) throw new ComposioError("not_found", 404);
  if (account.status === "revoked") throw new ComposioError("composio_not_connected", 409);
  const discovery = await discoverTools(database, ownerId, account, factory);
  if (!parsed.data.expectedToolsHash) return { kind: "discovery", discovery };
  if (parsed.data.expectedToolsHash !== discovery.toolsHash) throw new ComposioError("tools_changed", 409);
  if (account.pinnedAt && account.toolsHash && composioToolsHash(account.tools) !== account.toolsHash) {
    await updateComposioAccount(database, ownerId, id, { status: "changed" });
    throw new ComposioError("tools_changed", 409);
  }
  await updateComposioAccount(database, ownerId, id, {
    status: "active", tools: discovery.tools, toolsHash: discovery.toolsHash, pinnedNow: true,
  });
  const updated = await getComposioAccount(database, ownerId, id);
  if (!updated) throw new ComposioError("not_found", 404);
  return { kind: "pinned", account: accountView(updated) };
}

export async function disconnectComposioAccount(
  database: Database, ownerId: string, id: string, factory?: typeof createComposioClient,
): Promise<{ account: ComposioAccountView; revoked: boolean }> {
  const account = await getComposioAccount(database, ownerId, id);
  if (!account) throw new ComposioError("not_found", 404);
  await updateComposioAccount(database, ownerId, id, { status: "revoked" });
  let revoked = true;
  if (account.connectedAccountId) {
    await pushAgentCredentials(database, ownerId, account.agentId, { includeComposio: true }).catch(() => false);
    const client = clientFor(account.agentId, factory);
    revoked = await client.deleteAccount(account.connectedAccountId);
  }
  if (revoked) await database.transaction(async (transaction) => {
    await recordAudit(transaction as unknown as AuditExecutor, ownerId, {
      kind: "composio_account_revoked", agentId: account.agentId, code: account.toolkit,
    });
  });
  const updated = await getComposioAccount(database, ownerId, id);
  if (!updated) throw new ComposioError("not_found", 404);
  return { account: accountView(updated), revoked };
}

export type ComposioComposeDeps = { factory?: typeof createComposioClient };
