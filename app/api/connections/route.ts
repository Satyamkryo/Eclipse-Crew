import { z } from "zod";

import { getDatabase } from "@/db/client";
import { readBoundedJson, requireNoQuery, requireOwnerRequest } from "@/lib/auth/request";
import { connectionErrorResponse } from "@/lib/connections/http";
import { createConnection, listConnectionViews } from "@/lib/connections/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireOwnerRequest(request);
    const agentId = new URL(request.url).searchParams.get("agentId");
    if (agentId !== null && !z.string().uuid().safeParse(agentId).success) {
      return Response.json({ error: "invalid_query" }, { status: 400 });
    }
    const connections = await listConnectionViews(await getDatabase(), session.ownerId, agentId ?? undefined);
    return Response.json({ connections }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return connectionErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const created = await createConnection(await getDatabase(), session.ownerId, await readBoundedJson(request, 16 * 1024));
    return Response.json(created, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return connectionErrorResponse(error);
  }
}
