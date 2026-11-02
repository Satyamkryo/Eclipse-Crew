import { z } from "zod";
import { getDatabase } from "@/db/client";
import { requireNoQuery, requireOwnerRequest, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { captureView } from "@/lib/teach/service";
import { ownedCapture } from "@/lib/teach/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ captureId: string }> }) {
  try {
    const session = await requireOwnerRequest(request); requireNoQuery(request);
    const id = z.string().uuid().safeParse((await params).captureId);
    if (!id.success) throw new RequestError(400, "invalid_capture");
    return Response.json(captureView(await ownedCapture(await getDatabase(), session.ownerId, id.data)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return requestErrorResponse(error); }
}
