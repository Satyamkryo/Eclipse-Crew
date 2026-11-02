import { z } from "zod";
import { getDatabase } from "@/db/client";
import { requestErrorResponse, requireNoQuery, requireOwnerRequest, RequestError } from "@/lib/auth/request";
import { deleteScript } from "@/lib/replay/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

// Deletes the script only. The run it came from, and its receipts, stay.
export async function DELETE(request: Request, { params }: { params: Promise<{ scriptId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const scriptId = z.string().uuid().safeParse((await params).scriptId);
    if (!scriptId.success) throw new RequestError(400, "invalid_script");
    const removed = await deleteScript(await getDatabase(), session.ownerId, scriptId.data);
    return removed ? Response.json({ status: "deleted" }, { headers: NO_STORE }) : Response.json({ error: "script_not_found" }, { status: 404, headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
