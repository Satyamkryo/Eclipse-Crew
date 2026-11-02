import { z } from "zod";

import { getDatabase } from "@/db/client";
import { readBoundedJson, requireNoQuery, requireOwnerRequest } from "@/lib/auth/request";
import { composioErrorResponse } from "@/lib/composio/http";
import { disconnectComposioAccount, discoverComposioTools, pinComposioAccount } from "@/lib/composio/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ accountId: string }> }) {
  try {
    const session = await requireOwnerRequest(request);
    requireNoQuery(request);
    const id = z.string().uuid().safeParse((await params).accountId);
    if (!id.success) return Response.json({ error: "invalid_id" }, { status: 400 });
    return Response.json({ discovery: await discoverComposioTools(await getDatabase(), session.ownerId, id.data) },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return composioErrorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ accountId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const id = z.string().uuid().safeParse((await params).accountId);
    if (!id.success) return Response.json({ error: "invalid_id" }, { status: 400 });
    const result = await pinComposioAccount(await getDatabase(), session.ownerId, id.data, await readBoundedJson(request, 4096));
    return Response.json(result.kind === "discovery" ? { discovery: result.discovery } : { account: result.account },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return composioErrorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ accountId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const id = z.string().uuid().safeParse((await params).accountId);
    if (!id.success) return Response.json({ error: "invalid_id" }, { status: 400 });
    return Response.json(await disconnectComposioAccount(await getDatabase(), session.ownerId, id.data),
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return composioErrorResponse(error);
  }
}
