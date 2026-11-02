import { z } from "zod";
import { getDatabase } from "@/db/client";
import { requireOwnerRequest, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { createBlobStore } from "@/lib/artifacts/blob-store";
import { evidenceBelongsToRun } from "@/lib/receipts/history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_FOUND = { error: "evidence_not_found" };
const SECURITY = { "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'" };

// One stored screenshot of a run. Only a hash that the owner's own run lists as before/after evidence is served; the
// bytes are re-hashed on read, so a damaged or swapped file is a 404 and never reaches the page.
export async function GET(request: Request, { params }: { params: Promise<{ runId: string; hash: string }> }) {
  try {
    const session = await requireOwnerRequest(request);
    if (new URL(request.url).search) throw new RequestError(400, "invalid_query");
    const parsed = z.object({ runId: z.string().uuid(), hash: z.string().regex(/^[0-9a-f]{64}$/) }).safeParse(await params);
    if (!parsed.success) throw new RequestError(400, "invalid_evidence");
    if (!(await evidenceBelongsToRun(await getDatabase(), session.ownerId, parsed.data.runId, parsed.data.hash)))
      return Response.json(NOT_FOUND, { status: 404, headers: { ...SECURITY, "Cache-Control": "no-store" } });
    const bytes = await createBlobStore().get(parsed.data.hash).catch(() => null);
    if (!bytes) return Response.json(NOT_FOUND, { status: 404, headers: { ...SECURITY, "Cache-Control": "no-store" } });
    return new Response(new Uint8Array(bytes), { status: 200, headers: { ...SECURITY, "Content-Type": "image/png", "Content-Length": String(bytes.length),
      "Content-Disposition": "inline", "Cache-Control": "private, max-age=31536000, immutable" } });
  } catch (error) {
    const response = requestErrorResponse(error);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  }
}
