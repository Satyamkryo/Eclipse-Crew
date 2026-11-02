import { getDatabase } from "@/db/client";
import { readBoundedJson, requireNoQuery, requireOwnerRequest, requestErrorResponse } from "@/lib/auth/request";
import { priceInputSchema } from "@/lib/costs/schema";
import { upsertModelPrice } from "@/lib/costs/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const parsed = priceInputSchema.safeParse(await readBoundedJson(request));
    if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400 });
    const saved = await upsertModelPrice(await getDatabase(), session.ownerId, parsed.data);
    if (!saved) return Response.json({ error: "provider_not_found" }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    return requestErrorResponse(error);
  }
}
