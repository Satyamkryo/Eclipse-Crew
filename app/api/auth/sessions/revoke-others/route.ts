import { z } from "zod";
import { getDatabase } from "@/db/client";
import { revokeOtherSessions } from "@/lib/auth/account";
import { readBoundedJson, requireNoQuery, requireOwnerRequest, requestErrorResponse } from "@/lib/auth/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const emptySchema = z.object({}).strict();

export async function POST(request: Request) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const parsed = emptySchema.safeParse(await readBoundedJson(request, 4096));
    if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400 });
    await revokeOtherSessions(await getDatabase(), session.ownerId, session.sessionId);
    return Response.json({ ok: true });
  } catch (error) { return requestErrorResponse(error); }
}
