import "server-only";

import { randomUUID } from "node:crypto";

import type { getDatabase } from "../../db/client";
import { getAgentIdentity } from "../agents/data";
import { recordAudit, type AuditExecutor } from "../security/audit";
import { encryptSecret } from "../security/encryption";
import { keyHint } from "../security/key-hint";
import {
  countAgentConnections, deleteConnection, getConnection, insertConnection, labelExists,
  listConnections, updateConnection, type StoredConnection,
} from "./data";
import { ConnectionError } from "./errors";
import { presetBindings } from "./presets";
import { pushAgentCredentials } from "./proxy-credentials";
import {
  connectionCreateSchema, connectionUpdateSchema, type ConnectionBinding, type ConnectionPreset,
  type ConnectionUpdateInput,
} from "./schema";
import { createToolTransport } from "./transport";

type Database = Awaited<ReturnType<typeof getDatabase>>;
export const MAX_CONNECTIONS_PER_AGENT = 8;

export type ConnectionView = {
  id: string;
  agentId: string;
  preset: ConnectionPreset;
  label: string;
  bindings: ConnectionBinding[];
  hasToken: true;
  tokenHint: string;
  createdAt: string;
};

export type ConnectionTestResult = {
  status: "accepted" | "rejected" | "unreachable";
  latencyMs: number;
};

function view(row: StoredConnection): ConnectionView {
  return {
    id: row.id,
    agentId: row.agentId,
    preset: row.preset,
    label: row.label,
    bindings: row.bindings,
    hasToken: true,
    tokenHint: row.tokenHint,
    createdAt: row.createdAt.toISOString(),
  };
}

function encrypted(token: string) {
  try {
    return { encryptedToken: encryptSecret(token), tokenHint: keyHint(token) };
  } catch {
    throw new ConnectionError("encryption_unavailable", 503);
  }
}

export async function listConnectionViews(database: Database, ownerId: string, agentId?: string): Promise<ConnectionView[]> {
  return (await listConnections(database, ownerId, agentId)).map(view);
}

export async function createConnection(database: Database, ownerId: string, input: unknown): Promise<ConnectionView> {
  const parsed = connectionCreateSchema.safeParse(input);
  if (!parsed.success) throw new ConnectionError("invalid_input");
  const value = parsed.data;

  const agent = await getAgentIdentity(database, ownerId, value.agentId);
  if (!agent) throw new ConnectionError("not_found", 404);
  if (await countAgentConnections(database, ownerId, value.agentId) >= MAX_CONNECTIONS_PER_AGENT) {
    throw new ConnectionError("connection_limit", 409);
  }
  if (await labelExists(database, ownerId, value.agentId, value.label)) throw new ConnectionError("label_taken", 409);

  const bindings = presetBindings(value.preset, value.host, value.scheme ?? "bearer");
  const secrets = encrypted(value.token);
  const row: StoredConnection = {
    id: randomUUID(),
    ownerId,
    agentId: value.agentId,
    preset: value.preset,
    label: value.label,
    bindings,
    ...secrets,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  try {
    await database.transaction(async (transaction) => {
      await insertConnection(transaction, row);
      await recordAudit(transaction as unknown as AuditExecutor, ownerId, {
        kind: "connection_added", agentId: value.agentId, code: value.preset,
      });
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new ConnectionError("label_taken", 409);
    throw error;
  }
  await pushAgentCredentials(database, ownerId, value.agentId).catch(() => false);
  return view(row);
}

export async function updateConnectionForOwner(
  database: Database, ownerId: string, id: string, input: ConnectionUpdateInput,
): Promise<ConnectionView> {
  const parsed = connectionUpdateSchema.safeParse(input);
  if (!parsed.success) throw new ConnectionError("invalid_input");
  const existing = await getConnection(database, ownerId, id);
  if (!existing) throw new ConnectionError("not_found", 404);

  const label = parsed.data.label;
  if (label !== undefined && label !== existing.label &&
      await labelExists(database, ownerId, existing.agentId, label, id)) {
    throw new ConnectionError("label_taken", 409);
  }
  const token = parsed.data.token || undefined;
  const secrets = token ? encrypted(token) : {};

  try {
    await database.transaction(async (transaction) => {
      const changed = await updateConnection(transaction, ownerId, id, { ...(label !== undefined ? { label } : {}), ...secrets });
      if (!changed) throw new ConnectionError("not_found", 404);
      if (token) {
        await recordAudit(transaction as unknown as AuditExecutor, ownerId, {
          kind: "connection_replaced", agentId: existing.agentId, code: existing.preset,
        });
      }
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new ConnectionError("label_taken", 409);
    throw error;
  }
  if (token) await pushAgentCredentials(database, ownerId, existing.agentId).catch(() => false);
  const updated = await getConnection(database, ownerId, id);
  if (!updated) throw new ConnectionError("not_found", 404);
  return view(updated);
}

export async function removeConnection(database: Database, ownerId: string, id: string): Promise<void> {
  const existing = await getConnection(database, ownerId, id);
  if (!existing) throw new ConnectionError("not_found", 404);
  await database.transaction(async (transaction) => {
    const changed = await deleteConnection(transaction, ownerId, id);
    if (!changed) throw new ConnectionError("not_found", 404);
    await recordAudit(transaction as unknown as AuditExecutor, ownerId, {
      kind: "connection_removed", agentId: existing.agentId, code: existing.preset,
    });
  });
  await pushAgentCredentials(database, ownerId, existing.agentId).catch(() => false);
}

export async function testConnection(
  database: Database, ownerId: string, id: string,
  transportFactory: typeof createToolTransport = createToolTransport,
): Promise<ConnectionTestResult> {
  const existing = await getConnection(database, ownerId, id);
  if (!existing) throw new ConnectionError("not_found", 404);
  if (existing.preset !== "github") throw new ConnectionError("test_unsupported", 400);

  const started = Date.now();
  try {
    const transport = transportFactory({ agentId: existing.agentId });
    const response = await transport("https://api.github.com/user", {
      method: "GET", headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10_000),
    });
    try { await response.body?.cancel(); } catch { /* the body is never shown */ }
    const status = response.status;
    return { status: status >= 200 && status < 300 ? "accepted" : status === 401 || status === 403 ? "rejected" : "unreachable", latencyMs: Date.now() - started };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "upstream_timeout" || code === "upstream_error" || code === "forbidden_target" || code === "agent_unavailable") {
      return { status: "unreachable", latencyMs: Date.now() - started };
    }
    return { status: "unreachable", latencyMs: Date.now() - started };
  }
}
