import "server-only";

import { and, asc, eq } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { mcpServers } from "../../db/schema";
import { mcpToolsSchema, type McpPreset, type McpTool } from "./schema";

type Database = Awaited<ReturnType<typeof getDatabase>>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type McpStore = Pick<Database, "select">;

export type StoredMcpServer = {
  id: string;
  ownerId: string;
  agentId: string;
  key: string;
  preset: McpPreset;
  url: string;
  connectionId: string;
  serverName: string;
  serverVersion: string;
  protocolVersion: string;
  toolsHash: string;
  tools: McpTool[];
  status: "pinned" | "changed" | "disabled";
  pinnedAt: Date;
  createdAt: Date;
};

const fields = {
  id: mcpServers.id,
  ownerId: mcpServers.ownerId,
  agentId: mcpServers.agentId,
  key: mcpServers.key,
  preset: mcpServers.preset,
  url: mcpServers.url,
  connectionId: mcpServers.connectionId,
  serverName: mcpServers.serverName,
  serverVersion: mcpServers.serverVersion,
  protocolVersion: mcpServers.protocolVersion,
  toolsHash: mcpServers.toolsHash,
  tools: mcpServers.tools,
  status: mcpServers.status,
  pinnedAt: mcpServers.pinnedAt,
  createdAt: mcpServers.createdAt,
};

type McpRow = {
  id: string; ownerId: string; agentId: string; key: string; preset: string; url: string; connectionId: string;
  serverName: string; serverVersion: string; protocolVersion: string; toolsHash: string; tools: unknown;
  status: string; pinnedAt: Date; createdAt: Date;
};

function toStored(row: McpRow): StoredMcpServer | null {
  const tools = mcpToolsSchema.safeParse(row.tools);
  if (!tools.success) return null;
  return {
    id: row.id, ownerId: row.ownerId, agentId: row.agentId, key: row.key, preset: row.preset as McpPreset,
    url: row.url, connectionId: row.connectionId, serverName: row.serverName, serverVersion: row.serverVersion,
    protocolVersion: row.protocolVersion, toolsHash: row.toolsHash, tools: tools.data,
    status: row.status as StoredMcpServer["status"], pinnedAt: row.pinnedAt, createdAt: row.createdAt,
  };
}

export async function listMcpServers(database: McpStore, ownerId: string, agentId?: string): Promise<StoredMcpServer[]> {
  const rows = await database.select(fields).from(mcpServers)
    .where(agentId
      ? and(eq(mcpServers.ownerId, ownerId), eq(mcpServers.agentId, agentId))
      : eq(mcpServers.ownerId, ownerId))
    .orderBy(asc(mcpServers.key));
  return rows.map((row) => toStored(row as McpRow)).filter((row): row is StoredMcpServer => row !== null);
}

export async function getMcpServer(database: McpStore, ownerId: string, id: string): Promise<StoredMcpServer | undefined> {
  const rows = await database.select(fields).from(mcpServers)
    .where(and(eq(mcpServers.ownerId, ownerId), eq(mcpServers.id, id))).limit(1);
  return rows[0] ? toStored(rows[0] as McpRow) ?? undefined : undefined;
}

export async function getMcpServerByKey(database: McpStore, ownerId: string, agentId: string, key: string): Promise<StoredMcpServer | undefined> {
  const rows = await database.select(fields).from(mcpServers)
    .where(and(eq(mcpServers.ownerId, ownerId), eq(mcpServers.agentId, agentId), eq(mcpServers.key, key))).limit(1);
  return rows[0] ? toStored(rows[0] as McpRow) ?? undefined : undefined;
}

export async function insertMcpServer(database: Pick<Transaction, "insert">, row: StoredMcpServer): Promise<void> {
  await database.insert(mcpServers).values({
    id: row.id, ownerId: row.ownerId, agentId: row.agentId, key: row.key, preset: row.preset, url: row.url,
    connectionId: row.connectionId, serverName: row.serverName, serverVersion: row.serverVersion,
    protocolVersion: row.protocolVersion, toolsHash: row.toolsHash, tools: row.tools, status: row.status,
  });
}

export async function updateMcpPin(
  database: Pick<Transaction, "update">, ownerId: string, id: string,
  values: { serverName: string; serverVersion: string; protocolVersion: string; toolsHash: string; tools: McpTool[]; status: "pinned" },
): Promise<boolean> {
  const updated = await database.update(mcpServers).set({ ...values, pinnedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(mcpServers.ownerId, ownerId), eq(mcpServers.id, id))).returning({ id: mcpServers.id });
  return Boolean(updated[0]);
}

export async function setMcpStatus(
  database: Pick<Database, "update">, ownerId: string, id: string, status: "pinned" | "changed" | "disabled",
): Promise<void> {
  await database.update(mcpServers).set({ status, updatedAt: new Date() })
    .where(and(eq(mcpServers.ownerId, ownerId), eq(mcpServers.id, id)));
}

export async function deleteMcpServer(database: Pick<Database, "delete">, ownerId: string, id: string): Promise<boolean> {
  const deleted = await database.delete(mcpServers)
    .where(and(eq(mcpServers.ownerId, ownerId), eq(mcpServers.id, id))).returning({ id: mcpServers.id });
  return Boolean(deleted[0]);
}
