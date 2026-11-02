import { z } from "zod";

// TASK-072. The pinned tool snapshot. MCP servers may add fields; only these are stored and hashed, so the hash is stable
// across harmless additions but changes on any tool, annotation or input-schema change.
export const MCP_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
export const MCP_SERVER_KEY = /^[a-z0-9-]{1,32}$/;
export const MCP_TOOL_REFERENCE = /^[a-z0-9-]{1,32}\.[A-Za-z0-9_.:-]{1,128}$/;

export const mcpAnnotationsSchema = z.object({
  title: z.string().max(200).optional(),
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
}).strict();

export const mcpToolSchema = z.object({
  name: z.string().regex(MCP_TOOL_NAME),
  description: z.string().max(4096).optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: mcpAnnotationsSchema.optional(),
}).strict();

export const mcpToolsSchema = z.array(mcpToolSchema).max(512);

export type McpTool = z.infer<typeof mcpToolSchema>;
export type McpAnnotations = z.infer<typeof mcpAnnotationsSchema>;

export const mcpPresetSchema = z.enum(["github", "custom"]);
export type McpPreset = z.infer<typeof mcpPresetSchema>;

export const mcpDiscoverySchema = z.object({
  serverName: z.string().min(1).max(128),
  serverVersion: z.string().max(128),
  protocolVersion: z.string().min(1).max(32),
  tools: mcpToolsSchema,
  toolsHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type McpDiscovery = z.infer<typeof mcpDiscoverySchema>;

export const mcpCreateSchema = z.object({
  agentId: z.string().uuid(),
  preset: mcpPresetSchema,
  key: z.string().regex(MCP_SERVER_KEY),
  url: z.string().max(2048).optional(),
  connectionId: z.string().uuid(),
  expectedToolsHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict();

export const mcpRepinSchema = z.object({
  expectedToolsHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict();

export const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";
