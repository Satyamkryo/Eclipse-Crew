import "server-only";

import type { getDatabase } from "../../db/client";
import { createToolTransport } from "../connections/transport";
import { createComposioClient, type ComposioClient } from "../composio/client";
import { getComposioAccountByToolkit, getComposioKey, listComposioAccounts } from "../composio/data";
import { ComposioError } from "../composio/errors";
import { composioToolsHash, livePinFromTools } from "../composio/risk";
import { COMPOSIO_HOST, type PinnedComposioTool } from "../composio/schema";
import { buildComposioSession, formatComposioResult } from "../composio/session";
import { createMcpClient, type McpClient } from "../mcp/client";
import { getMcpServerByKey, setMcpStatus } from "../mcp/data";
import { McpError } from "../mcp/errors";
import { toolsHash } from "../mcp/pin";
import { MCP_SERVER_KEY, MCP_TOOL_NAME, type McpAnnotations } from "../mcp/schema";

type Database = Awaited<ReturnType<typeof getDatabase>>;

export const MAX_ARGUMENT_CHARS = 6000;
export const MAX_RESULT_CHARS = 16_000;
export const COMPOSIO_AGENT_KEY = "composio";

export type ToolCallResult = {
  server: string;
  tool: string;
  host: string;
  text: string;
  isError: boolean;
};

export interface PreparedTool {
  serverKey: string;
  tool: string;
  host: string;
  description: string | null;
  annotations: McpAnnotations | undefined;
  invoke(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolCallResult>;
}

export interface PrepareOptions {
  // TASK-076 will narrow a subagent run to a subset of its parent's grant; a normal run uses the whole pin.
  allowedTools?: readonly string[];
}

// The step loop and tests see only this. URLs, sessions and tokens stay below it.
export interface ToolPort {
  prepare(reference: string, signal?: AbortSignal, options?: PrepareOptions): Promise<PreparedTool>;
  close?(): Promise<void>;
}

export function splitToolReference(reference: string): { serverKey: string; tool: string } | null {
  const dot = reference.indexOf(".");
  if (dot < 1) return null;
  const serverKey = reference.slice(0, dot);
  const tool = reference.slice(dot + 1);
  return MCP_SERVER_KEY.test(serverKey) && MCP_TOOL_NAME.test(tool) ? { serverKey, tool } : null;
}

export function createToolPort(options: {
  database: Database;
  ownerId: string;
  agentId: string;
  transportFactory?: typeof createToolTransport;
  composioFactory?: typeof createComposioClient;
}): ToolPort {
  const transportFactory = options.transportFactory ?? createToolTransport;
  const clients = new Map<string, { client: McpClient; initialized: boolean }>();
  const composioSessions = new Map<string, Promise<{ client: ComposioClient; sessionId: string }>>();

  async function mcpClient(serverId: string, url: string): Promise<McpClient> {
    const existing = clients.get(serverId);
    if (existing) {
      if (!existing.initialized) { await existing.client.initialize(); existing.initialized = true; }
      return existing.client;
    }
    const client = createMcpClient({ transport: transportFactory({ agentId: options.agentId }), url });
    clients.set(serverId, { client, initialized: false });
    try { await client.initialize(); clients.get(serverId)!.initialized = true; }
    catch (error) { clients.delete(serverId); throw error; }
    return client;
  }

  async function prepareMcp(reference: string, signal?: AbortSignal): Promise<PreparedTool> {
    const split = splitToolReference(reference);
    if (!split) throw new McpError("tool_not_pinned", 403);
    const server = await getMcpServerByKey(options.database, options.ownerId, options.agentId, split.serverKey);
    if (!server) throw new McpError("tool_not_pinned", 403);
    if (server.status !== "pinned") throw new McpError("tools_changed", 409);
    const client = await mcpClient(server.id, server.url);
    const live = await client.listTools(signal);
    if (toolsHash(live) !== server.toolsHash) {
      await setMcpStatus(options.database, options.ownerId, server.id, "changed").catch(() => undefined);
      throw new McpError("tools_changed", 409);
    }
    const tool = live.find((item) => item.name === split.tool);
    if (!tool) throw new McpError("tools_changed", 409);
    const host = new URL(server.url).hostname.toLowerCase();
    return {
      serverKey: server.key,
      tool: tool.name,
      host,
      description: tool.description ?? null,
      annotations: tool.annotations,
      async invoke(args, callSignal) {
        if (JSON.stringify(args).length > MAX_ARGUMENT_CHARS) throw new McpError("tool_args_too_large", 400);
        const result = await client.callTool(tool.name, args, callSignal);
        const text = result.text.length > MAX_RESULT_CHARS
          ? `${result.text.slice(0, MAX_RESULT_CHARS)}\n[result truncated]`
          : result.text;
        return { server: server.key, tool: tool.name, host, text, isError: result.isError };
      },
    };
  }

  async function prepareComposio(tool: string, signal?: AbortSignal, allowedTools?: readonly string[]): Promise<PreparedTool> {
    const key = await getComposioKey(options.database, options.ownerId);
    if (!key?.encryptedKey) throw new ComposioError("composio_not_configured", 409);
    let match: { toolkit: string; tool: PinnedComposioTool; accountId: string | null } | null = null;
    for (const account of await listComposioAccounts(options.database, options.ownerId, options.agentId)) {
      if (account.status !== "active") continue;
      const pinned = account.tools.find((item) => item.slug === tool);
      if (pinned) { match = { toolkit: account.toolkit, tool: pinned, accountId: account.connectedAccountId }; break; }
    }
    if (!match) throw new ComposioError("composio_not_connected", 409);
    if (allowedTools && !allowedTools.includes(tool)) throw new ComposioError("tool_not_pinned", 403);
    const active = match;

    let sessionPromise = composioSessions.get(active.toolkit);
    if (!sessionPromise) {
      sessionPromise = (async () => {
        const account = await getComposioAccountByToolkit(options.database, options.ownerId, options.agentId, active.toolkit);
        const body = buildComposioSession({
          agentId: options.agentId,
          accounts: active.accountId ? [{ toolkit: active.toolkit, connectedAccountId: active.accountId }] : [],
          pinned: account?.tools ?? [],
          injectionCheck: key.injectionCheck,
          ...(allowedTools ? { allowedSlugs: allowedTools } : {}),
        });
        const client = options.composioFactory
          ? (options.composioFactory as unknown as (options: unknown) => ComposioClient)({ transport: null })
          : createComposioClient({ transport: transportFactory({ agentId: options.agentId }) });
        const sessionId = await client.createSession(body);
        return { client, sessionId };
      })();
      composioSessions.set(active.toolkit, sessionPromise);
    }
    let session: { client: ComposioClient; sessionId: string };
    try { session = await sessionPromise; }
    catch (error) {
      if (composioSessions.get(active.toolkit) === sessionPromise) composioSessions.delete(active.toolkit);
      throw error;
    }
    const live = await session.client.listTools(session.sessionId);
    const { hash } = livePinFromTools(live.filter((item) => (item.toolkit?.slug ?? item.slug.split("_")[0].toLowerCase()) === active.toolkit));
    const account = await getComposioAccountByToolkit(options.database, options.ownerId, options.agentId, active.toolkit);
    if (!account?.toolsHash || hash !== composioToolsHash(account.tools)) throw new ComposioError("tools_changed", 409);
    void signal;

    return {
      serverKey: COMPOSIO_AGENT_KEY,
      tool: active.tool.slug,
      // The approval site is per toolkit, so "Always allow" is per agent + toolkit + class.
      host: `${COMPOSIO_HOST}/${active.toolkit}`,
      description: active.tool.description || null,
      annotations: { destructiveHint: active.tool.tags.includes("destructiveHint") },
      async invoke(args, callSignal) {
        if (JSON.stringify(args).length > MAX_ARGUMENT_CHARS) throw new ComposioError("tool_args_too_large", 400);
        void callSignal;
        const reply = await session.client.execute(session.sessionId, active.tool.slug, args, active.accountId ?? undefined);
        const resultHost = `${COMPOSIO_HOST}/${active.toolkit}`;
        if (reply.resultType === "completed") {
          return { server: COMPOSIO_AGENT_KEY, tool: active.tool.slug, host: resultHost, text: formatComposioResult(reply.data), isError: false };
        }
        if (reply.resultType === "input_required") throw new ComposioError("composio_input_required", 409);
        if (reply.resultType === "blocked") {
          throw new ComposioError(reply.blockedHookId === "eclipse_injection_check" ? "composio_injection_blocked" : "composio_blocked", 403);
        }
        return { server: COMPOSIO_AGENT_KEY, tool: active.tool.slug, host: resultHost, text: formatComposioResult(reply.error), isError: true };
      },
    };
  }

  return {
    async prepare(reference, signal, prepareOptions) {
      const split = splitToolReference(reference);
      if (!split) throw new McpError("tool_not_pinned", 403);
      if (split.serverKey === COMPOSIO_AGENT_KEY) return prepareComposio(split.tool, signal, prepareOptions?.allowedTools);
      return prepareMcp(reference, signal);
    },
    async close() {
      const sessions = [...composioSessions.values()];
      composioSessions.clear();
      await Promise.allSettled(sessions.map(async (pending) => {
        const session = await pending;
        await session.client.deleteSession(session.sessionId);
      }));
    },
  };
}
