import "server-only";

import { and, asc, eq } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { connections } from "../../db/schema";
import { connectionBindingsSchema, type ConnectionBinding, type ConnectionPreset } from "./schema";

type Database = Awaited<ReturnType<typeof getDatabase>>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type ConnectionStore = Pick<Database, "select">;
type MutationStore = Pick<Database, "select" | "insert" | "update" | "delete">;

export type StoredConnection = {
  id: string;
  ownerId: string;
  agentId: string;
  preset: ConnectionPreset;
  label: string;
  bindings: ConnectionBinding[];
  encryptedToken: string;
  tokenHint: string;
  // TASK-088. Only GitHub App connections carry these; a pasted token has nulls and `pasted`.
  encryptedRefreshToken: string | null;
  tokenExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
  source: "pasted" | "github_app";
  status: "active" | "expired";
  createdAt: Date;
  updatedAt: Date;
};

const fields = {
  id: connections.id,
  ownerId: connections.ownerId,
  agentId: connections.agentId,
  preset: connections.preset,
  label: connections.label,
  bindings: connections.bindings,
  encryptedToken: connections.encryptedToken,
  tokenHint: connections.tokenHint,
  encryptedRefreshToken: connections.encryptedRefreshToken,
  tokenExpiresAt: connections.tokenExpiresAt,
  refreshExpiresAt: connections.refreshExpiresAt,
  source: connections.source,
  status: connections.status,
  createdAt: connections.createdAt,
  updatedAt: connections.updatedAt,
};

type ConnectionRow = {
  id: string;
  ownerId: string;
  agentId: string;
  preset: string;
  label: string;
  bindings: unknown;
  encryptedToken: string;
  tokenHint: string;
  encryptedRefreshToken: string | null;
  tokenExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
  source: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

function toStored(row: ConnectionRow): StoredConnection | null {
  const parsed = connectionBindingsSchema.safeParse(row.bindings);
  if (!parsed.success) return null;
  return {
    id: row.id,
    ownerId: row.ownerId,
    agentId: row.agentId,
    preset: row.preset as ConnectionPreset,
    label: row.label,
    bindings: parsed.data,
    encryptedToken: row.encryptedToken,
    tokenHint: row.tokenHint,
    encryptedRefreshToken: row.encryptedRefreshToken ?? null,
    tokenExpiresAt: row.tokenExpiresAt ?? null,
    refreshExpiresAt: row.refreshExpiresAt ?? null,
    source: row.source === "github_app" ? "github_app" : "pasted",
    status: row.status === "expired" ? "expired" : "active",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listConnections(database: ConnectionStore, ownerId: string, agentId?: string): Promise<StoredConnection[]> {
  const rows = await database.select(fields).from(connections)
    .where(agentId
      ? and(eq(connections.ownerId, ownerId), eq(connections.agentId, agentId))
      : eq(connections.ownerId, ownerId))
    .orderBy(asc(connections.label));
  return rows.map((row) => toStored(row as ConnectionRow)).filter((row): row is StoredConnection => row !== null);
}

export async function getConnection(database: ConnectionStore, ownerId: string, id: string): Promise<StoredConnection | undefined> {
  const rows = await database.select(fields).from(connections)
    .where(and(eq(connections.ownerId, ownerId), eq(connections.id, id))).limit(1);
  return rows[0] ? toStored(rows[0] as ConnectionRow) ?? undefined : undefined;
}

export async function countAgentConnections(database: ConnectionStore, ownerId: string, agentId: string): Promise<number> {
  const rows = await database.select({ id: connections.id }).from(connections)
    .where(and(eq(connections.ownerId, ownerId), eq(connections.agentId, agentId)));
  return rows.length;
}

export async function labelExists(database: ConnectionStore, ownerId: string, agentId: string, label: string, exceptId?: string): Promise<boolean> {
  const rows = await database.select({ id: connections.id }).from(connections)
    .where(and(eq(connections.ownerId, ownerId), eq(connections.agentId, agentId), eq(connections.label, label)));
  return rows.some((row) => row.id !== exceptId);
}

export async function findConnectionByLabel(database: ConnectionStore, ownerId: string, agentId: string, label: string): Promise<StoredConnection | undefined> {
  const rows = await database.select(fields).from(connections)
    .where(and(eq(connections.ownerId, ownerId), eq(connections.agentId, agentId), eq(connections.label, label))).limit(1);
  return rows[0] ? toStored(rows[0] as ConnectionRow) ?? undefined : undefined;
}

export async function insertConnection(database: Pick<Transaction, "insert">, row: StoredConnection): Promise<void> {
  await database.insert(connections).values({
    id: row.id,
    ownerId: row.ownerId,
    agentId: row.agentId,
    preset: row.preset,
    label: row.label,
    bindings: row.bindings,
    encryptedToken: row.encryptedToken,
    tokenHint: row.tokenHint,
    encryptedRefreshToken: row.encryptedRefreshToken,
    tokenExpiresAt: row.tokenExpiresAt,
    refreshExpiresAt: row.refreshExpiresAt,
    source: row.source,
    status: row.status,
  });
}

export async function updateConnection(
  database: Pick<Transaction, "update">, ownerId: string, id: string,
  values: {
    label?: string; encryptedToken?: string; tokenHint?: string; encryptedRefreshToken?: string | null;
    tokenExpiresAt?: Date | null; refreshExpiresAt?: Date | null; source?: "pasted" | "github_app"; status?: "active" | "expired";
  },
): Promise<boolean> {
  const updated = await database.update(connections).set({
    ...(values.label !== undefined ? { label: values.label } : {}),
    ...(values.encryptedToken !== undefined ? { encryptedToken: values.encryptedToken } : {}),
    ...(values.tokenHint !== undefined ? { tokenHint: values.tokenHint } : {}),
    ...(values.encryptedRefreshToken !== undefined ? { encryptedRefreshToken: values.encryptedRefreshToken } : {}),
    ...(values.tokenExpiresAt !== undefined ? { tokenExpiresAt: values.tokenExpiresAt } : {}),
    ...(values.refreshExpiresAt !== undefined ? { refreshExpiresAt: values.refreshExpiresAt } : {}),
    ...(values.source !== undefined ? { source: values.source } : {}),
    ...(values.status !== undefined ? { status: values.status } : {}),
    updatedAt: new Date(),
  }).where(and(eq(connections.ownerId, ownerId), eq(connections.id, id))).returning({ id: connections.id });
  return Boolean(updated[0]);
}

export async function deleteConnection(database: Pick<Transaction, "delete">, ownerId: string, id: string): Promise<boolean> {
  const deleted = await database.delete(connections)
    .where(and(eq(connections.ownerId, ownerId), eq(connections.id, id))).returning({ id: connections.id });
  return Boolean(deleted[0]);
}

export type MutationDatabase = MutationStore;
