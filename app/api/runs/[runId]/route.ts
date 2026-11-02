import { z } from "zod";
import { getDatabase } from "@/db/client";
import { requireOwnerRequest, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { loadRunDetail } from "@/lib/receipts/history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

// One run's timeline with the chain checked now. A run of another owner and an unknown run look the same.
export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const session = await requireOwnerRequest(request);
    if (new URL(request.url).search) throw new RequestError(400, "invalid_query");
    const parsed = z.object({ runId: z.string().uuid() }).safeParse(await params);
    if (!parsed.success) throw new RequestError(400, "invalid_run");
    const detail = await loadRunDetail(await getDatabase(), session.ownerId, parsed.data.runId);
    if (!detail) return Response.json({ error: "run_not_found" }, { status: 404, headers: NO_STORE });
    return Response.json(detail, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
