import "server-only";

import { and, asc, eq } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { composioAccounts, composioKeys } from "../../db/schema";
import { pinnedComposioToolsSchema, type PinnedComposioTool } from "./schema";

type Database = Awaited<ReturnType<typeof getDatabase>>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type ComposioStore = Pick<Database, "select">;

export type StoredComposioKey = {
  id: string;
  ownerId: string;
  encryptedKey: string;
  keyHint: string;
  injectionCheck: boolean;
};

export type StoredComposioAccount = {
  id: string;
  ownerId: string;
  agentId: string;
  toolkit: string;
  connectedAccountId: string | null;
  status: "pending" | "active" | "failed" | "revoked" | "changed";
  toolsHash: string | null;
  tools: PinnedComposioTool[];
  pinnedAt: Date | null;
  createdAt: Date;
};

export async function getComposioKey(database: ComposioStore, ownerId: string): Promise<StoredComposioKey | undefined> {
  const rows = await database.select({
    id: composioKeys.id, ownerId: composioKeys.ownerId, encryptedKey: composioKeys.encryptedKey,
    keyHint: composioKeys.keyHint, injectionCheck: composioKeys.injectionCheck,
  }).from(composioKeys).where(eq(composioKeys.ownerId, ownerId)).limit(1);
  return rows[0];
}

export async function upsertComposioKey(database: Pick<Database, "select" | "insert" | "update">, ownerId: string, values: {
  id: string; encryptedKey?: string; keyHint?: string; injectionCheck?: boolean;
}): Promise<void> {
  const rows = await database.select({ id: composioKeys.id }).from(composioKeys).where(eq(composioKeys.ownerId, ownerId)).limit(1);
  if (!rows[0]) {
    await database.insert(composioKeys).values({
      id: values.id, ownerId, encryptedKey: values.encryptedKey ?? "", keyHint: values.keyHint ?? "",
      injectionCheck: values.injectionCheck ?? false,
    });
    return;
  }
  await database.update(composioKeys).set({
    ...(values.encryptedKey !== undefined ? { encryptedKey: values.encryptedKey } : {}),
    ...(values.keyHint !== undefined ? { keyHint: values.keyHint } : {}),
    ...(values.injectionCheck !== undefined ? { injectionCheck: values.injectionCheck } : {}),
    updatedAt: new Date(),
  }).where(eq(composioKeys.ownerId, ownerId));
}

export async function deleteComposioKey(database: Pick<Database, "delete">, ownerId: string): Promise<boolean> {
  const deleted = await database.delete(composioKeys).where(eq(composioKeys.ownerId, ownerId)).returning({ id: composioKeys.id });
  return Boolean(deleted[0]);
}

function toAccount(row: {
  id: string; ownerId: string; agentId: string; toolkit: string; connectedAccountId: string | null; status: string;
  toolsHash: string | null; tools: unknown; pinnedAt: Date | null; createdAt: Date;
}): StoredComposioAccount | null {
  let pinned: PinnedComposioTool[] = [];
  if (row.tools !== null) {
    const parsed = pinnedComposioToolsSchema.safeParse(row.tools);
    if (!parsed.success) return null;
    pinned = parsed.data;
  }
  return {
    id: row.id, ownerId: row.ownerId, agentId: row.agentId, toolkit: row.toolkit,
    connectedAccountId: row.connectedAccountId, status: row.status as StoredComposioAccount["status"],
    toolsHash: row.toolsHash, tools: pinned,
    pinnedAt: row.pinnedAt, createdAt: row.createdAt,
  };
}

const accountFields = {
  id: composioAccounts.id, ownerId: composioAccounts.ownerId, agentId: composioAccounts.agentId,
  toolkit: composioAccounts.toolkit, connectedAccountId: composioAccounts.connectedAccountId,
  status: composioAccounts.status, toolsHash: composioAccounts.toolsHash, tools: composioAccounts.tools,
  pinnedAt: composioAccounts.pinnedAt, createdAt: composioAccounts.createdAt,
};

export async function listComposioAccounts(database: ComposioStore, ownerId: string, agentId?: string): Promise<StoredComposioAccount[]> {
  const rows = await database.select(accountFields).from(composioAccounts)
    .where(agentId
      ? and(eq(composioAccounts.ownerId, ownerId), eq(composioAccounts.agentId, agentId))
      : eq(composioAccounts.ownerId, ownerId))
    .orderBy(asc(composioAccounts.toolkit));
  return rows.map(toAccount).filter((row): row is StoredComposioAccount => row !== null);
}

export async function getComposioAccount(database: ComposioStore, ownerId: string, id: string): Promise<StoredComposioAccount | undefined> {
  const rows = await database.select(accountFields).from(composioAccounts)
    .where(and(eq(composioAccounts.ownerId, ownerId), eq(composioAccounts.id, id))).limit(1);
  return rows[0] ? toAccount(rows[0]) ?? undefined : undefined;
}

export async function getComposioAccountByToolkit(database: ComposioStore, ownerId: string, agentId: string, toolkit: string): Promise<StoredComposioAccount | undefined> {
  const rows = await database.select(accountFields).from(composioAccounts)
    .where(and(eq(composioAccounts.ownerId, ownerId), eq(composioAccounts.agentId, agentId), eq(composioAccounts.toolkit, toolkit))).limit(1);
  return rows[0] ? toAccount(rows[0]) ?? undefined : undefined;
}

export async function insertComposioAccount(database: Pick<Transaction, "insert">, row: StoredComposioAccount): Promise<void> {
  await database.insert(composioAccounts).values({
    id: row.id, ownerId: row.ownerId, agentId: row.agentId, toolkit: row.toolkit,
    connectedAccountId: row.connectedAccountId, status: row.status,
  });
}

export async function updateComposioAccount(
  database: Pick<Database, "update">, ownerId: string, id: string,
  values: {
    connectedAccountId?: string | null; status?: StoredComposioAccount["status"];
    tools?: PinnedComposioTool[]; toolsHash?: string | null; pinnedNow?: boolean;
  },
): Promise<void> {
  await database.update(composioAccounts).set({
    ...(values.connectedAccountId !== undefined ? { connectedAccountId: values.connectedAccountId } : {}),
    ...(values.status !== undefined ? { status: values.status } : {}),
    ...(values.tools !== undefined ? { tools: values.tools } : {}),
    ...(values.toolsHash !== undefined ? { toolsHash: values.toolsHash } : {}),
    ...(values.pinnedNow ? { pinnedAt: new Date() } : {}),
    updatedAt: new Date(),
  }).where(and(eq(composioAccounts.ownerId, ownerId), eq(composioAccounts.id, id)));
}

export async function deleteComposioAccount(database: Pick<Database, "delete">, ownerId: string, id: string): Promise<boolean> {
  const deleted = await database.delete(composioAccounts)
    .where(and(eq(composioAccounts.ownerId, ownerId), eq(composioAccounts.id, id))).returning({ id: composioAccounts.id });
  return Boolean(deleted[0]);
}
