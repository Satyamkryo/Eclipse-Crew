import { z } from "zod";
import { getDatabase } from "@/db/client";
import { changeOwnerTimezone } from "@/lib/auth/account";
import { readBoundedJson, requireNoQuery, requireOwnerRequest, requestErrorResponse } from "@/lib/auth/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const timezoneSchema = z.object({ timezone: z.string().min(1).max(64) }).strict();

export async function POST(request: Request) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const parsed = timezoneSchema.safeParse(await readBoundedJson(request, 1024));
    if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400 });
    const changed = await changeOwnerTimezone(await getDatabase(), session.ownerId, parsed.data.timezone);
    if (!changed) return Response.json({ error: "invalid_timezone" }, { status: 400 });
    return Response.json({ ok: true });
  } catch (error) { return requestErrorResponse(error); }
}
