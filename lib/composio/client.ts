import "server-only";

import { ToolTransportError, type ToolTransport } from "../connections/transport";
import { ComposioError } from "./errors";
import {
  COMPOSIO_BASE, COMPOSIO_MAX_TOOLS, composioToolSchema, executeReplySchema, linkReplySchema, sessionReplySchema,
  toolkitsReplySchema, toolsReplySchema, type ComposioTool,
} from "./schema";

// TASK-075. REST through the egress proxy, which injects the Composio key. No SDK: every request and reply is bounded
// and validated here. Composio's own message text is never shown or logged.
const REPLY_LIMIT = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export type ComposioExecReply = {
  resultType: string;
  data: unknown;
  error: unknown;
  blockedHookId: string | null;
};

export interface ComposioClient {
  createSession(body: Record<string, unknown>): Promise<string>;
  deleteSession(sessionId: string): Promise<void>;
  listTools(sessionId: string): Promise<ComposioTool[]>;
  toolkitStatus(sessionId: string, toolkits: string[]): Promise<Array<{ slug: string; status: string; accountId: string | null }>>;
  createLink(sessionId: string, toolkit: string): Promise<{ connectedAccountId: string; redirectUrl: string }>;
  execute(sessionId: string, slug: string, args: Record<string, unknown>, accountId?: string): Promise<ComposioExecReply>;
  deleteAccount(accountId: string): Promise<boolean>;
}

function mapError(error: unknown): never {
  if (error instanceof ComposioError) throw error;
  if (error instanceof ToolTransportError) {
    if (error.code === "canary_blocked") throw new ComposioError("canary_blocked", 403);
    if (error.code === "agent_unavailable") throw new ComposioError("agent_unavailable", 403);
    throw new ComposioError("composio_unreachable", 502);
  }
  throw new ComposioError("composio_unreachable", 502);
}

export function createComposioClient(options: {
  transport: ToolTransport;
  baseUrl?: string;
  timeoutMs?: number;
}): ComposioClient {
  const base = options.baseUrl ?? COMPOSIO_BASE;
  const timeout = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  async function request(path: string, init: { method: "GET" | "POST" | "DELETE"; body?: unknown; signal?: AbortSignal }) {
    let response: Response;
    try {
      response = await options.transport(`${base}${path}`, {
        method: init.method,
        headers: { accept: "application/json", ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.any([AbortSignal.timeout(timeout), ...(init.signal ? [init.signal] : [])]),
      });
    } catch (error) { mapError(error); }
    if (response.status === 401 || response.status === 403) throw new ComposioError("key_rejected", 401);
    if (response.status === 429) throw new ComposioError("composio_rate_limited", 429);
    if (response.status === 404) throw new ComposioError("composio_not_found", 404);
    if (response.status >= 500 && response.status !== 501) throw new ComposioError("composio_unreachable", 502);
    if (!response.ok) throw new ComposioError("composio_rejected", response.status);
    let text: string;
    try { text = (await response.text()).slice(0, REPLY_LIMIT); } catch { throw new ComposioError("composio_unreachable", 502); }
    if (response.status === 204 || !text) return null;
    try { return JSON.parse(text) as unknown; } catch { throw new ComposioError("composio_unexpected_reply", 502); }
  }

  function validated<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ComposioError("composio_unexpected_reply", 502);
    return parsed.data;
  }

  return {
    async createSession(body) {
      const reply = validated(sessionReplySchema, await request("/tool_router/session", { method: "POST", body }));
      return reply.session_id;
    },
    async deleteSession(sessionId) {
      await request(`/tool_router/session/${encodeURIComponent(sessionId)}`, { method: "DELETE" }).catch(() => null);
    },
    async listTools(sessionId) {
      const tools: ComposioTool[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page += 1) {
        const query: string = `limit=${COMPOSIO_MAX_TOOLS}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const reply: { items: ComposioTool[]; next_cursor?: string | null } = validated(toolsReplySchema,
          await request(`/tool_router/session/${encodeURIComponent(sessionId)}/tools?${query}`, { method: "GET" }));
        for (const item of reply.items) {
          const parsed = composioToolSchema.safeParse(item);
          if (parsed.success) tools.push(parsed.data as ComposioTool);
        }
        cursor = reply.next_cursor ?? null;
        if (!cursor) return tools;
      }
      throw new ComposioError("composio_unexpected_reply", 502);
    },
    async toolkitStatus(sessionId, toolkits) {
      const reply = validated(toolkitsReplySchema, await request(
        `/tool_router/session/${encodeURIComponent(sessionId)}/toolkits?toolkits=${encodeURIComponent(toolkits.join(","))}&is_connected=true&limit=50`,
        { method: "GET" },
      ));
      return reply.items.map((item) => ({
        slug: item.slug,
        status: item.connected_account?.status ?? "INITIALIZING",
        accountId: item.connected_account?.id ?? null,
      }));
    },
    async createLink(sessionId, toolkit) {
      const reply = validated(linkReplySchema,
        await request(`/tool_router/session/${encodeURIComponent(sessionId)}/link`, { method: "POST", body: { toolkit } }));
      return { connectedAccountId: reply.connected_account_id, redirectUrl: reply.redirect_url };
    },
    async execute(sessionId, slug, args, accountId) {
      const reply = validated(executeReplySchema, await request(
        `/tool_router/session/${encodeURIComponent(sessionId)}/execute`,
        { method: "POST", body: { tool_slug: slug, arguments: args, ...(accountId ? { account: accountId } : {}) } },
      ));
      return {
        resultType: reply.result_type,
        data: reply.data ?? null,
        error: reply.error ?? null,
        blockedHookId: reply.block_reason?.hook_id ?? null,
      };
    },
    async deleteAccount(accountId) {
      try {
        await request(`/connected_accounts/${encodeURIComponent(accountId)}?revoke_on_delete=true`, { method: "DELETE" });
        return true;
      } catch { return false; }
    },
  };
}

export function safeRedirectUrl(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (url.hostname !== "composio.dev" && !url.hostname.endsWith(".composio.dev")) return null;
  return url.href;
}
