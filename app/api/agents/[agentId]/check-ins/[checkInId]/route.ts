import { z } from "zod";
import { getDatabase } from "@/db/client";
import { readBoundedJson, requestErrorResponse, requireNoQuery, requireOwnerRequest, RequestError } from "@/lib/auth/request";
import { checkInUpdateSchema } from "@/lib/check-ins/logic";
import { deleteCheckIn, setCheckInActive } from "@/lib/check-ins/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
type Params = { params: Promise<{ agentId: string; checkInId: string }> };

function withHeaders(response: Response): Response {
  for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
  return response;
}

async function ids(params: Params["params"]) {
  const raw = await params;
  const agentId = z.string().uuid().safeParse(raw.agentId);
  const checkInId = z.string().uuid().safeParse(raw.checkInId);
  if (!agentId.success || !checkInId.success) throw new RequestError(400, "invalid_input");
  return { agentId: agentId.data, checkInId: checkInId.data };
}

// Pause or resume one check-in.
export async function PATCH(request: Request, { params }: Params) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const { agentId, checkInId } = await ids(params);
    const body = checkInUpdateSchema.safeParse(await readBoundedJson(request, 1024));
    if (!body.success) return Response.json({ error: "invalid_input" }, { status: 400, headers: NO_STORE });
    const checkIn = await setCheckInActive(await getDatabase(), session.ownerId, agentId, checkInId, body.data.active);
    return Response.json({ checkIn }, { headers: NO_STORE });
  } catch (error) {
    return withHeaders(requestErrorResponse(error));
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const { agentId, checkInId } = await ids(params);
    await deleteCheckIn(await getDatabase(), session.ownerId, agentId, checkInId);
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return withHeaders(requestErrorResponse(error));
  }
}
