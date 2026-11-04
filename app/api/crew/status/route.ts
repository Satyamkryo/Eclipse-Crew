import { eq } from "drizzle-orm";

import { getDatabase } from "@/db/client";
import { owner } from "@/db/schema";
import { requireNoQuery, requireOwnerRequest, requestErrorResponse } from "@/lib/auth/request";
import { loadCrewStatus } from "@/lib/crew/status";
import { validTimezone } from "@/lib/crew/time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function GET(request: Request) {
  try {
    const session = await requireOwnerRequest(request);
    requireNoQuery(request);
    const database = await getDatabase();
    const rows = await database.select({ timezone: owner.timezone }).from(owner).where(eq(owner.id, session.ownerId)).limit(1);
    const timezone = validTimezone(rows[0]?.timezone) ?? "UTC";
    const status = await loadCrewStatus(database, session.ownerId, timezone);
    return Response.json(status, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
