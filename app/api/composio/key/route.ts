import { getDatabase } from "@/db/client";
import { readBoundedJson, requireNoQuery, requireOwnerRequest } from "@/lib/auth/request";
import { composioErrorResponse } from "@/lib/composio/http";
import { readComposioKey, removeComposioKey, saveComposioKey } from "@/lib/composio/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireOwnerRequest(request);
    requireNoQuery(request);
    return Response.json(await readComposioKey(await getDatabase(), session.ownerId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return composioErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    return Response.json(await saveComposioKey(await getDatabase(), session.ownerId, await readBoundedJson(request, 16 * 1024)),
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return composioErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    return Response.json(await removeComposioKey(await getDatabase(), session.ownerId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return composioErrorResponse(error);
  }
}
