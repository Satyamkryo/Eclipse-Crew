import { z } from "zod";
import { getDatabase } from "@/db/client";
import { requestErrorResponse, requireNoQuery, requireOwnerRequest, RequestError } from "@/lib/auth/request";
import { checkNow } from "@/lib/check-ins/runner";
import { getCheckIn, toCheckInView } from "@/lib/check-ins/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const recent = new Map<string, number>();

// Run one check right now (outside its hours too). Same guards and probe as the scheduler; at most once per 30 s.
export async function POST(request: Request, { params }: { params: Promise<{ agentId: string; checkInId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const raw = await params;
    const agentId = z.string().uuid().safeParse(raw.agentId);
    const checkInId = z.string().uuid().safeParse(raw.checkInId);
    if (!agentId.success || !checkInId.success) throw new RequestError(400, "invalid_input");
    const last = recent.get(checkInId.data) ?? 0;
    if (Date.now() - last < 30_000) throw new RequestError(429, "check_too_soon");
    recent.set(checkInId.data, Date.now());
    const database = await getDatabase();
    const row = await getCheckIn(database, session.ownerId, agentId.data, checkInId.data);
    if (!row) throw new RequestError(404, "check_in_not_found");
    const outcome = await checkNow(database, row);
    const updated = await getCheckIn(database, session.ownerId, agentId.data, checkInId.data);
    return Response.json({ status: outcome.status, checkIn: updated ? toCheckInView(updated) : null }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
