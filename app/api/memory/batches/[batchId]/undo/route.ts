import { z } from "zod";
import { getDatabase } from "@/db/client";
import { requireNoQuery, requireOwnerRequest, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { undoMemoryBatch } from "@/lib/memory/tidy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

// TASK-086. One Undo restores every entry a tidy batch touched.
export async function POST(request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const batchId = z.string().uuid().safeParse((await params).batchId);
    if (!batchId.success) throw new RequestError(400, "invalid_batch");
    const result = await undoMemoryBatch(await getDatabase(), session.ownerId, batchId.data);
    if (!result.ok) return Response.json({ error: result.error }, { status: 404, headers: NO_STORE });
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
