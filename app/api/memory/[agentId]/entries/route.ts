import { z } from "zod";
import { getDatabase } from "@/db/client";
import { requireNoQuery, requireOwnerRequest, readBoundedJson, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { getMirrorStatus } from "@/lib/memory/mirror";
import { ownerAddSchema } from "@/lib/memory/schema";
import { applyMemoryChange } from "@/lib/memory/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const agentId = z.string().uuid().safeParse((await params).agentId);
    if (!agentId.success) throw new RequestError(400, "invalid_agent");
    const body = ownerAddSchema.safeParse(await readBoundedJson(request, 8 * 1024));
    if (!body.success) return Response.json({ error: "invalid_input" }, { status: 400, headers: NO_STORE });
    const database = await getDatabase();
    const result = await applyMemoryChange(database, session.ownerId, {
      op: "add", doc: body.data.doc, agentId: body.data.doc === "user" ? null : agentId.data,
      title: body.data.title, body: body.data.body, pinned: body.data.pinned,
      visibleTo: body.data.doc === "private" ? body.data.visibleTo : undefined,
      author: "owner",
    });
    if (!result.ok) return Response.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 409, headers: NO_STORE });
    return Response.json({
      entry: result.entry, versionId: result.versionId, mirror: getMirrorStatus(session.ownerId, agentId.data),
    }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
