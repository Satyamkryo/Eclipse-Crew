import { z } from "zod";
import { getDatabase } from "@/db/client";
import { requireOwnerRequest, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { loadRunExport } from "@/lib/receipts/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

// The owner's run as one `eclipse-crew-run/1` file for offline checking (`eclipse-crew verify`). Always a download.
// A run that belongs to someone else and a run that does not exist look the same.
export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const session = await requireOwnerRequest(request);
    if (new URL(request.url).search) throw new RequestError(400, "invalid_query");
    const parsed = z.object({ runId: z.string().uuid() }).safeParse(await params);
    if (!parsed.success) throw new RequestError(400, "invalid_run");
    const exported = await loadRunExport(await getDatabase(), session.ownerId, parsed.data.runId);
    if (!exported) return Response.json({ error: "run_not_found" }, { status: 404, headers: NO_STORE });
    return new Response(JSON.stringify(exported), { status: 200, headers: {
      ...NO_STORE, "Content-Type": "application/json", "Content-Disposition": `attachment; filename="run-${parsed.data.runId}.json"`,
      "Content-Security-Policy": "sandbox; default-src 'none'",
    } });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
