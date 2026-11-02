import { z } from "zod";
import { getDatabase } from "@/db/client";
import { requireNoQuery, requireOwnerRequest, readBoundedJson, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { getMirrorStatus } from "@/lib/memory/mirror";
import { ownerEditSchema } from "@/lib/memory/schema";
import { applyMemoryChange } from "@/lib/memory/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

// Owners may edit an entry or toggle its pin. Removal is a separate DELETE with its own confirmation in the UI.
export async function PATCH(request: Request, { params }: { params: Promise<{ entryId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const entryId = z.string().uuid().safeParse((await params).entryId);
    if (!entryId.success) throw new RequestError(400, "invalid_entry");
    const body = ownerEditSchema.safeParse(await readBoundedJson(request, 8 * 1024));
    if (!body.success) return Response.json({ error: "invalid_input" }, { status: 400, headers: NO_STORE });
    const database = await getDatabase();
    const result = body.data.pinned !== undefined && Object.keys(body.data).length === 1
      ? await applyMemoryChange(database, session.ownerId, {
        op: body.data.pinned ? "pin" : "unpin", entryId: entryId.data, author: "owner",
      })
      : await applyMemoryChange(database, session.ownerId, {
        op: "edit", entryId: entryId.data, ...body.data, author: "owner",
      });
    if (!result.ok) return Response.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 409, headers: NO_STORE });
    return Response.json({
      entry: result.entry, versionId: result.versionId,
      mirror: result.entry.agentId ? getMirrorStatus(session.ownerId, result.entry.agentId) : getMirrorStatus(session.ownerId, null),
    }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ entryId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const entryId = z.string().uuid().safeParse((await params).entryId);
    if (!entryId.success) throw new RequestError(400, "invalid_entry");
    const database = await getDatabase();
    const result = await applyMemoryChange(database, session.ownerId, { op: "remove", entryId: entryId.data, author: "owner" });
    if (!result.ok) return Response.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 409, headers: NO_STORE });
    return Response.json({ ok: true, mirror: result.entry.agentId ? getMirrorStatus(session.ownerId, result.entry.agentId) : getMirrorStatus(session.ownerId, null) }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
