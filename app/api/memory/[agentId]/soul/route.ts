import { z } from "zod";
import { getDatabase } from "@/db/client";
import { requireNoQuery, requireOwnerRequest, readBoundedJson, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { getMirrorStatus } from "@/lib/memory/mirror";
import { soulInputSchema } from "@/lib/memory/schema";
import { updateSoul } from "@/lib/memory/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function PUT(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const agentId = z.string().uuid().safeParse((await params).agentId);
    if (!agentId.success) throw new RequestError(400, "invalid_agent");
    const body = soulInputSchema.safeParse(await readBoundedJson(request, 8 * 1024));
    if (!body.success) return Response.json({ error: "invalid_input" }, { status: 400, headers: NO_STORE });
    const result = await updateSoul(await getDatabase(), session.ownerId, agentId.data, body.data.soulMd);
    if (!result.ok) return Response.json({ error: result.error }, { status: 404, headers: NO_STORE });
    return Response.json({
      ok: true, soul: { text: result.text }, versionId: result.versionId,
      mirror: getMirrorStatus(session.ownerId, agentId.data),
    }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
