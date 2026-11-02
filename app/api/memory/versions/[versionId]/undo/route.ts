import { z } from "zod";
import { getDatabase } from "@/db/client";
import { requireNoQuery, requireOwnerRequest, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { undoMemoryVersion } from "@/lib/memory/changes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function POST(request: Request, { params }: { params: Promise<{ versionId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const versionId = z.string().uuid().safeParse((await params).versionId);
    if (!versionId.success) throw new RequestError(400, "invalid_version");
    const result = await undoMemoryVersion(await getDatabase(), session.ownerId, versionId.data);
    if (!result.ok) {
      return Response.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 409, headers: NO_STORE });
    }
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
