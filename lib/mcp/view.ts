import type { McpAnnotations, McpPreset } from "./schema";

// TASK-072. Client-safe shapes. The server module builds these; no secret or server-only import is involved.
export type McpToolView = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: McpAnnotations;
  write: boolean;
};

export type McpServerView = {
  id: string;
  agentId: string;
  key: string;
  preset: McpPreset;
  url: string;
  serverName: string;
  serverVersion: string;
  protocolVersion: string;
  toolsHash: string;
  tools: McpToolView[];
  status: "pinned" | "changed" | "disabled";
  pinnedAt: string;
};

export type McpDiscoveryView = {
  serverName: string;
  serverVersion: string;
  protocolVersion: string;
  toolsHash: string;
  url: string;
  host: string;
  tools: McpToolView[];
};
