import { z } from "zod";
import { getDatabase } from "@/db/client";
import { requireNoQuery, requireOwnerRequest, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { getChange } from "@/lib/memory/changes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function GET(request: Request, { params }: { params: Promise<{ changeId: string }> }) {
  try {
    const session = await requireOwnerRequest(request);
    requireNoQuery(request);
    const changeId = z.string().uuid().safeParse((await params).changeId);
    if (!changeId.success) throw new RequestError(400, "invalid_change");
    const change = await getChange(await getDatabase(), session.ownerId, changeId.data);
    if (!change) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    return Response.json({ change }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
