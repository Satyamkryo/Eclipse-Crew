import { z } from "zod";

import { getDatabase } from "@/db/client";
import { requireNoQuery, requireOwnerRequest, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { loadRunCostReceipt } from "@/lib/costs/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'" };

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const session = await requireOwnerRequest(request);
    requireNoQuery(request);
    const parsed = z.object({ runId: z.string().uuid() }).safeParse(await params);
    if (!parsed.success) throw new RequestError(400, "invalid_run");
    const receipt = await loadRunCostReceipt(await getDatabase(), session.ownerId, parsed.data.runId);
    if (!receipt) return Response.json({ error: "run_not_found" }, { status: 404, headers: HEADERS });
    return Response.json(receipt, { headers: HEADERS });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(HEADERS)) response.headers.set(key, value);
    return response;
  }
}
