import { z } from "zod";

import { getDatabase } from "@/db/client";
import { requireNoQuery, requireOwnerRequest } from "@/lib/auth/request";
import { composioErrorResponse } from "@/lib/composio/http";
import { checkComposioRateLimit } from "@/lib/composio/rate-limit";
import { refreshComposioAccount } from "@/lib/composio/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ accountId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const rate = checkComposioRateLimit();
    if (!rate.allowed) {
      return Response.json({ error: "rate_limited", retryAfter: rate.retryAfter },
        { status: 429, headers: { "Retry-After": String(rate.retryAfter), "Cache-Control": "no-store" } });
    }
    const id = z.string().uuid().safeParse((await params).accountId);
    if (!id.success) return Response.json({ error: "invalid_id" }, { status: 400 });
    return Response.json({ account: await refreshComposioAccount(await getDatabase(), session.ownerId, id.data) },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return composioErrorResponse(error);
  }
}
