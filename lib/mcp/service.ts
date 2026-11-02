import "server-only";

import { randomUUID } from "node:crypto";

import type { getDatabase } from "../../db/client";
import { getAgentIdentity } from "../agents/data";
import { getConnection, type StoredConnection } from "../connections/data";
import { createToolTransport } from "../connections/transport";
import { McpError } from "./errors";
import {
  deleteMcpServer, getMcpServer, getMcpServerByKey, insertMcpServer, listMcpServers,
  setMcpStatus, updateMcpPin, type StoredMcpServer,
} from "./data";
import { createMcpClient } from "./client";
import { toolsHash } from "./pin";
import {
  GITHUB_MCP_URL, mcpCreateSchema, mcpRepinSchema, type McpPreset, type McpTool,
} from "./schema";

type Database = Awaited<ReturnType<typeof getDatabase>>;
export type McpServiceDeps = { transportFactory?: typeof createToolTransport };

export const MIN_TOOLS = 1;
export const MAX_TOOLS = 512;

import type { McpDiscoveryView, McpServerView, McpToolView } from "./view";
export type { McpDiscoveryView, McpServerView, McpToolView };

export type CreateMcpResult = { kind: "discovery"; discovery: McpDiscoveryView } | { kind: "pinned"; server: McpServerView };

// TASK-072. The model never supplies a URL. The linked connection must already be allowed to receive its token at this host.
function targetFor(connection: StoredConnection, preset: McpPreset, url: string | undefined): { url: string; host: string } {
  const chosen = preset === "github" ? GITHUB_MCP_URL : url;
  if (!chosen) throw new McpError("url_required", 400);
  let parsed: URL;
  try { parsed = new URL(chosen); } catch { throw new McpError("invalid_url", 400); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || parsed.port) throw new McpError("invalid_url", 400);
  const host = parsed.hostname.toLowerCase();
  if (!connection.bindings.some((binding) => binding.host === host)) throw new McpError("host_not_in_connection", 400);
  return { url: parsed.href, host };
}

function toolViews(tools: McpTool[]): McpToolView[] {
  return tools.map((tool) => ({
    ...tool,
    write: !(tool.annotations?.readOnlyHint === true) || tool.annotations?.destructiveHint === true,
  }));
}

function plainTools(tools: McpToolView[]): McpTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  }));
}

function view(row: StoredMcpServer): McpServerView {
  return {
    id: row.id, agentId: row.agentId, key: row.key, preset: row.preset, url: row.url,
    serverName: row.serverName, serverVersion: row.serverVersion, protocolVersion: row.protocolVersion,
    toolsHash: row.toolsHash, tools: toolViews(row.tools), status: row.status, pinnedAt: row.pinnedAt.toISOString(),
  };
}

async function runDiscovery(connection: StoredConnection, preset: McpPreset, agentId: string, url?: string, deps: McpServiceDeps = {}): Promise<McpDiscoveryView> {
  const target = targetFor(connection, preset, url);
  const client = createMcpClient({ transport: (deps.transportFactory ?? createToolTransport)({ agentId }), url: target.url });
  const info = await client.initialize();
  const tools = await client.listTools();
  if (tools.length < MIN_TOOLS || tools.length > MAX_TOOLS) throw new McpError("not_an_mcp_server", 502);
  const serialized = JSON.stringify(tools);
  if (Buffer.byteLength(serialized, "utf8") > 262_144) throw new McpError("tools_too_large", 413);
  return {
    serverName: info.serverName, serverVersion: info.serverVersion, protocolVersion: info.protocolVersion,
    tools: toolViews(tools), toolsHash: toolsHash(tools), url: target.url, host: target.host,
  };
}

async function loadConnection(database: Database, ownerId: string, agentId: string, connectionId: string): Promise<StoredConnection> {
  const agent = await getAgentIdentity(database, ownerId, agentId);
  if (!agent) throw new McpError("not_found", 404);
  const connection = await getConnection(database, ownerId, connectionId);
  if (!connection || connection.agentId !== agentId) throw new McpError("not_found", 404);
  return connection;
}

export async function listMcpServerViews(database: Database, ownerId: string, agentId?: string): Promise<McpServerView[]> {
  return (await listMcpServers(database, ownerId, agentId)).map(view);
}

export async function createMcpServer(database: Database, ownerId: string, input: unknown, deps: McpServiceDeps = {}): Promise<CreateMcpResult> {
  const parsed = mcpCreateSchema.safeParse(input);
  if (!parsed.success) throw new McpError("invalid_input", 400);
  const value = parsed.data;
  const connection = await loadConnection(database, ownerId, value.agentId, value.connectionId);
  const discovery = await runDiscovery(connection, value.preset, value.agentId, value.url, deps);
  if (!value.expectedToolsHash) return { kind: "discovery", discovery };
  if (value.expectedToolsHash !== discovery.toolsHash) throw new McpError("tools_changed", 409);
  if (await getMcpServerByKey(database, ownerId, value.agentId, value.key)) throw new McpError("key_taken", 409);

  const row: StoredMcpServer = {
    id: randomUUID(), ownerId, agentId: value.agentId, key: value.key, preset: value.preset, url: discovery.url,
    connectionId: value.connectionId, serverName: discovery.serverName, serverVersion: discovery.serverVersion,
    protocolVersion: discovery.protocolVersion, toolsHash: discovery.toolsHash,
    tools: plainTools(discovery.tools), status: "pinned",
    pinnedAt: new Date(), createdAt: new Date(),
  };
  try { await insertMcpServer(database, row); }
  catch (error) {
    if ((error as { code?: string }).code === "23505") throw new McpError("key_taken", 409);
    throw error;
  }
  return { kind: "pinned", server: view(row) };
}

export async function repinMcpServer(database: Database, ownerId: string, id: string, input: unknown, deps: McpServiceDeps = {}): Promise<CreateMcpResult> {
  const parsed = mcpRepinSchema.safeParse(input);
  if (!parsed.success) throw new McpError("invalid_input", 400);
  const existing = await getMcpServer(database, ownerId, id);
  if (!existing) throw new McpError("not_found", 404);
  const connection = await loadConnection(database, ownerId, existing.agentId, existing.connectionId);
  const discovery = await runDiscovery(connection, existing.preset, existing.agentId, existing.url, deps);
  if (!parsed.data.expectedToolsHash) return { kind: "discovery", discovery };
  if (parsed.data.expectedToolsHash !== discovery.toolsHash) throw new McpError("tools_changed", 409);
  await updateMcpPin(database, ownerId, id, {
    serverName: discovery.serverName, serverVersion: discovery.serverVersion, protocolVersion: discovery.protocolVersion,
    toolsHash: discovery.toolsHash, tools: plainTools(discovery.tools), status: "pinned",
  });
  const updated = await getMcpServer(database, ownerId, id);
  if (!updated) throw new McpError("not_found", 404);
  return { kind: "pinned", server: view(updated) };
}

export async function removeMcpServer(database: Database, ownerId: string, id: string): Promise<void> {
  if (!(await deleteMcpServer(database, ownerId, id))) throw new McpError("not_found", 404);
}

export async function markMcpChanged(database: Database, ownerId: string, id: string): Promise<void> {
  await setMcpStatus(database, ownerId, id, "changed");
}
