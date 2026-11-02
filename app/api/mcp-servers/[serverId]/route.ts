import { z } from "zod";

import { getDatabase } from "@/db/client";
import { readBoundedJson, requireNoQuery, requireOwnerRequest } from "@/lib/auth/request";
import { mcpErrorResponse } from "@/lib/mcp/http";
import { checkMcpDiscoveryRateLimit } from "@/lib/mcp/rate-limit";
import { removeMcpServer, repinMcpServer } from "@/lib/mcp/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ serverId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const id = z.string().uuid().safeParse((await params).serverId);
    if (!id.success) return Response.json({ error: "invalid_id" }, { status: 400 });
    const rate = checkMcpDiscoveryRateLimit();
    if (!rate.allowed) {
      return Response.json({ error: "rate_limited", retryAfter: rate.retryAfter },
        { status: 429, headers: { "Retry-After": String(rate.retryAfter), "Cache-Control": "no-store" } });
    }
    const result = await repinMcpServer(await getDatabase(), session.ownerId, id.data, await readBoundedJson(request, 4096));
    return result.kind === "discovery"
      ? Response.json({ discovery: result.discovery }, { headers: { "Cache-Control": "no-store" } })
      : Response.json(result.server, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return mcpErrorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ serverId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const id = z.string().uuid().safeParse((await params).serverId);
    if (!id.success) return Response.json({ error: "invalid_id" }, { status: 400 });
    await removeMcpServer(await getDatabase(), session.ownerId, id.data);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return mcpErrorResponse(error);
  }
}
