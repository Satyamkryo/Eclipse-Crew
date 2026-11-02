import "server-only";

import { requireEgressProxySecret } from "../config/server";
import { EGRESS_PROXY_URL } from "../providers/proxy-transport";

export class ToolTransportError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
    this.name = "ToolTransportError";
  }
}

export type ToolMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ToolRequest = {
  method: ToolMethod;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

const FORWARDED = new Set(["content-type", "accept", "mcp-session-id", "mcp-protocol-version"]);

// TASK-070. A fetch-like client for the proxy's /v1/tool-forward. The app supplies the agent and the target URL;
// the proxy supplies the credential. The caller can never set Authorization, and the agent identity comes from this
// app-authenticated call, never from anything the agent controls.
export function createToolTransport(options: {
  agentId: string;
  secret?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}) {
  const secret = requireEgressProxySecret(options.secret ?? process.env.EGRESS_PROXY_SECRET);
  const baseUrl = options.baseUrl ?? EGRESS_PROXY_URL;
  const send = options.fetchImpl ?? fetch;

  return async (target: string, init: ToolRequest): Promise<Response> => {
    const url = new URL(target);
    if (url.protocol !== "https:" || url.username || url.password) throw new ToolTransportError("forbidden_target", 403);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${secret}`,
      "X-Eclipse-Agent": options.agentId,
      "X-Eclipse-Target": url.href,
      "X-Eclipse-Method": init.method,
    };
    for (const [name, value] of Object.entries(init.headers ?? {})) {
      if (FORWARDED.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
    }
    const response = await send(`${baseUrl}/v1/tool-forward`, {
      method: "POST",
      headers,
      body: init.body,
      redirect: "error",
      signal: init.signal,
    });
    if (response.headers.get("x-eclipse-proxy") !== "ok") {
      let code = "upstream_error";
      try {
        const body = await response.json() as { error?: unknown };
        if (typeof body.error === "string" && /^[a-z_]{1,48}$/.test(body.error)) code = body.error;
      } catch { /* keep the fixed fallback */ }
      throw new ToolTransportError(code, response.status);
    }
    return response;
  };
}

export type ToolTransport = ReturnType<typeof createToolTransport>;
