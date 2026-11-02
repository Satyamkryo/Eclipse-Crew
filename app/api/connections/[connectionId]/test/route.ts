import { z } from "zod";

import { getDatabase } from "@/db/client";
import { requireNoQuery, requireOwnerRequest } from "@/lib/auth/request";
import { connectionErrorResponse } from "@/lib/connections/http";
import { checkConnectionTestRateLimit } from "@/lib/connections/rate-limit";
import { testConnection } from "@/lib/connections/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const rate = checkConnectionTestRateLimit();
    if (!rate.allowed) {
      return Response.json({ error: "rate_limited", retryAfter: rate.retryAfter },
        { status: 429, headers: { "Retry-After": String(rate.retryAfter) } });
    }
    const id = z.string().uuid().safeParse((await params).connectionId);
    if (!id.success) return Response.json({ error: "invalid_id" }, { status: 400 });
    const result = await testConnection(await getDatabase(), session.ownerId, id.data);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return connectionErrorResponse(error);
  }
}
