import { getDatabase } from "@/db/client";
import { readBoundedJson, requireNoQuery, requireOwnerRequest } from "@/lib/auth/request";
import { createModelSettingsStore } from "@/lib/models/data";
import { modelErrorResponse } from "@/lib/models/http";
import { checkModelTestRateLimit } from "@/lib/models/rate-limit";
import { testModelSchema } from "@/lib/models/schema";
import { testSavedRole } from "@/lib/models/testing";
import { proxyTransportFor } from "@/lib/models/transport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const rate = checkModelTestRateLimit();
    if (!rate.allowed) {
      return Response.json({ error: "rate_limited", retryAfter: rate.retryAfter },
        { status: 429, headers: { "Retry-After": String(rate.retryAfter) } });
    }
    const parsed = testModelSchema.safeParse(await readBoundedJson(request, 4096));
    if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400 });
    const store = createModelSettingsStore(await getDatabase());
    return Response.json(await testSavedRole(store, session.ownerId, parsed.data.role, undefined, proxyTransportFor));
  } catch (error) {
    return modelErrorResponse(error);
  }
}
