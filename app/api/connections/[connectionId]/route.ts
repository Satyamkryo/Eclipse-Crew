import { z } from "zod";

import { getDatabase } from "@/db/client";
import { readBoundedJson, requireNoQuery, requireOwnerRequest } from "@/lib/auth/request";
import { connectionErrorResponse } from "@/lib/connections/http";
import { removeConnection, updateConnectionForOwner } from "@/lib/connections/service";
import { connectionUpdateSchema } from "@/lib/connections/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const id = z.string().uuid().safeParse((await params).connectionId);
    if (!id.success) return Response.json({ error: "invalid_id" }, { status: 400 });
    const body = await readBoundedJson(request, 16 * 1024);
    const parsed = connectionUpdateSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400 });
    const updated = await updateConnectionForOwner(await getDatabase(), session.ownerId, id.data, parsed.data);
    return Response.json(updated, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return connectionErrorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const id = z.string().uuid().safeParse((await params).connectionId);
    if (!id.success) return Response.json({ error: "invalid_id" }, { status: 400 });
    await removeConnection(await getDatabase(), session.ownerId, id.data);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return connectionErrorResponse(error);
  }
}
