import "server-only";

import { ToolTransportError, type ToolTransport } from "../connections/transport";
import { McpError } from "./errors";
import { mcpToolSchema, mcpToolsSchema, type McpTool } from "./schema";

// TASK-072. A deliberately small Streamable HTTP client: initialize, tools/list and tools/call over JSON-RPC 2.0.
// One JSON reply or one SSE reply is accepted; server-pushed streams, resources, prompts, sampling and roots are out of scope.
const PROTOCOL_VERSION = "2025-06-18";
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_REPLY_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

export type McpCallResult = { text: string; isError: boolean };

export interface McpClient {
  initialize(): Promise<{ serverName: string; serverVersion: string; protocolVersion: string }>;
  listTools(signal?: AbortSignal): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
}

type Reply = { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };

function protocolFailure(): McpError {
  return new McpError("mcp_protocol_error", 502);
}

async function readBounded(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new McpError("mcp_reply_too_large", 502);
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text: string, expectedId: number): Reply {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw protocolFailure(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw protocolFailure();
  const reply = value as Reply;
  if (reply.id !== expectedId && reply.id !== undefined) throw protocolFailure();
  return reply;
}

function parseSse(text: string, expectedId: number): Reply {
  const events = text.replace(/\r\n/g, "\n").split("\n\n");
  for (const event of events) {
    const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    if (!data) continue;
    let value: unknown;
    try { value = JSON.parse(data); } catch { continue; }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const reply = value as Reply;
    if (reply.id === expectedId) return reply;
  }
  throw protocolFailure();
}

function message(reply: Reply): unknown {
  if (reply.error) throw new McpError("mcp_protocol_error", 502);
  return reply.result;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function createMcpClient(options: {
  transport: ToolTransport;
  url: string;
  timeoutMs?: number;
  maxReplyBytes?: number;
}): McpClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxReplyBytes = options.maxReplyBytes ?? MAX_REPLY_BYTES;
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let nextId = 0;

  async function send(method: string, params: Record<string, unknown> | undefined, signal: AbortSignal | undefined, notification = false) {
    const id = notification ? null : ++nextId;
    const payload = { jsonrpc: "2.0", ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) };
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new McpError("mcp_request_too_large", 400);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await options.transport(options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
        },
        body,
        signal: controller.signal,
      });
      const returnedSession = response.headers.get("mcp-session-id");
      if (returnedSession && /^[\x21-\x7e]{1,256}$/.test(returnedSession)) sessionId = returnedSession;
      if (notification) {
        try { await response.body?.cancel(); } catch { /* no body */ }
        if (!response.ok && response.status !== 202) throw new McpError("mcp_protocol_error", 502);
        return null;
      }
      if (response.status === 401 || response.status === 403) throw new McpError("token_rejected", 401);
      if (response.status === 404) throw new McpError("not_an_mcp_server", 404);
      if (response.status >= 500) throw new McpError("server_unreachable", 502);
      if (!response.ok) throw new McpError("mcp_protocol_error", 502);
      const text = await readBounded(response, maxReplyBytes);
      const type = (response.headers.get("content-type") ?? "").toLowerCase();
      const reply = type.includes("text/event-stream") ? parseSse(text, id as number) : parseJson(text, id as number);
      return message(reply);
    } catch (error) {
      if (error instanceof McpError) throw error;
      if (error instanceof ToolTransportError) {
        if (error.code === "canary_blocked") throw new McpError("canary_blocked", 403);
        if (error.code === "agent_unavailable") throw new McpError("agent_unavailable", 403);
        if (error.code === "upstream_timeout") throw new McpError("server_unreachable", 504);
        throw new McpError("server_unreachable", 502);
      }
      if (controller.signal.aborted) throw new McpError("server_unreachable", 504);
      throw new McpError("server_unreachable", 502);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  return {
    async initialize() {
      const result = asRecord(await send("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "eclipse-crew", version: "1" },
      }, undefined));
      const serverInfo = asRecord(result.serverInfo);
      const version = typeof result.protocolVersion === "string" && /^[0-9A-Za-z.-]{1,32}$/.test(result.protocolVersion)
        ? result.protocolVersion : PROTOCOL_VERSION;
      protocolVersion = version;
      await send("notifications/initialized", undefined, undefined, true);
      return {
        serverName: typeof serverInfo.name === "string" && serverInfo.name.length <= 128 ? serverInfo.name : "MCP server",
        serverVersion: typeof serverInfo.version === "string" && serverInfo.version.length <= 128 ? serverInfo.version : "",
        protocolVersion: version,
      };
    },

    async listTools(signal) {
      const result = asRecord(await send("tools/list", {}, signal));
      if (!Array.isArray(result.tools)) throw new McpError("not_an_mcp_server", 502);
      const parsed = mcpToolsSchema.safeParse(result.tools.map((tool) => {
        const value = asRecord(tool);
        const rawAnnotations = value.annotations && typeof value.annotations === "object" && !Array.isArray(value.annotations)
          ? asRecord(value.annotations) : null;
        const annotations = rawAnnotations ? {
          ...(typeof rawAnnotations.title === "string" ? { title: rawAnnotations.title.slice(0, 200) } : {}),
          ...Object.fromEntries(["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]
            .filter((key) => typeof rawAnnotations[key] === "boolean").map((key) => [key, rawAnnotations[key]])),
        } : null;
        return {
          name: value.name,
          ...(typeof value.description === "string" ? { description: value.description.slice(0, 4096) } : {}),
          ...(value.inputSchema && typeof value.inputSchema === "object" && !Array.isArray(value.inputSchema) ? { inputSchema: value.inputSchema } : {}),
          ...(annotations ? { annotations } : {}),
        };
      }));
      if (!parsed.success) throw new McpError("not_an_mcp_server", 502);
      return parsed.data;
    },

    async callTool(name, args, signal) {
      const result = asRecord(await send("tools/call", { name, arguments: args }, signal));
      const content = Array.isArray(result.content) ? result.content.slice(0, 64) : [];
      const parts: string[] = [];
      for (const block of content) {
        const value = asRecord(block);
        if (value.type === "text" && typeof value.text === "string") parts.push(value.text);
        else if (value.type === "image") parts.push("[image omitted]");
        else if (value.type === "resource") parts.push("[resource omitted]");
        else if (value.type === "audio") parts.push("[audio omitted]");
      }
      return { text: parts.join("\n").slice(0, 16_000), isError: result.isError === true };
    },
  };
}

export { mcpToolSchema, mcpToolsSchema };
export type { McpTool };
