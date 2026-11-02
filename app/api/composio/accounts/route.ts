import { z } from "zod";

import { getDatabase } from "@/db/client";
import { readBoundedJson, requireNoQuery, requireOwnerRequest } from "@/lib/auth/request";
import { composioErrorResponse } from "@/lib/composio/http";
import { checkComposioRateLimit } from "@/lib/composio/rate-limit";
import { connectComposioAccount, listComposioAccountViews } from "@/lib/composio/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireOwnerRequest(request);
    const agentId = new URL(request.url).searchParams.get("agentId");
    if (agentId !== null && !z.string().uuid().safeParse(agentId).success) {
      return Response.json({ error: "invalid_query" }, { status: 400 });
    }
    return Response.json({ accounts: await listComposioAccountViews(await getDatabase(), session.ownerId, agentId ?? undefined) },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return composioErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const rate = checkComposioRateLimit();
    if (!rate.allowed) {
      return Response.json({ error: "rate_limited", retryAfter: rate.retryAfter },
        { status: 429, headers: { "Retry-After": String(rate.retryAfter), "Cache-Control": "no-store" } });
    }
    const result = await connectComposioAccount(await getDatabase(), session.ownerId, await readBoundedJson(request, 4096));
    return Response.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return composioErrorResponse(error);
  }
}
