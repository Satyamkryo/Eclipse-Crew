import { z } from "zod";

import { getDatabase } from "@/db/client";
import { readBoundedJson, requireNoQuery, requireOwnerRequest } from "@/lib/auth/request";
import { mcpErrorResponse } from "@/lib/mcp/http";
import { checkMcpDiscoveryRateLimit } from "@/lib/mcp/rate-limit";
import { createMcpServer, listMcpServerViews } from "@/lib/mcp/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireOwnerRequest(request);
    const agentId = new URL(request.url).searchParams.get("agentId");
    if (agentId !== null && !z.string().uuid().safeParse(agentId).success) {
      return Response.json({ error: "invalid_query" }, { status: 400 });
    }
    const servers = await listMcpServerViews(await getDatabase(), session.ownerId, agentId ?? undefined);
    return Response.json({ servers }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return mcpErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const rate = checkMcpDiscoveryRateLimit();
    if (!rate.allowed) {
      return Response.json({ error: "rate_limited", retryAfter: rate.retryAfter },
        { status: 429, headers: { "Retry-After": String(rate.retryAfter), "Cache-Control": "no-store" } });
    }
    const result = await createMcpServer(await getDatabase(), session.ownerId, await readBoundedJson(request, 300 * 1024));
    return result.kind === "discovery"
      ? Response.json({ discovery: result.discovery }, { headers: { "Cache-Control": "no-store" } })
      : Response.json(result.server, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return mcpErrorResponse(error);
  }
}
