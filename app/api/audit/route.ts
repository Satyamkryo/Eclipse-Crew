import { z } from "zod";
import { getDatabase } from "@/db/client";
import { requireOwnerRequest, requestErrorResponse } from "@/lib/auth/request";
import { auditStatus, listAudit } from "@/lib/security/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const querySchema = z.object({
  agent: z.string().uuid().optional(),
  group: z.enum(["security", "admin"]).optional(),
  range: z.enum(["24h", "7d", "30d", "all"]).default("7d"),
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  verifyStatus: z.enum(["1"]).optional(),
}).strict();

export async function GET(request: Request) {
  try {
    const session = await requireOwnerRequest(request);
    const url = new URL(request.url);
    const query = querySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!query.success) return Response.json({ error: "invalid_query" }, { status: 400, headers: NO_STORE });
    const database = await getDatabase();
    const [view, status] = await Promise.all([
      listAudit(database, session.ownerId, query.data),
      query.data.before === undefined && (query.data.verifyStatus === "1"
        || (!query.data.agent && !query.data.group && query.data.range === "7d"))
        ? auditStatus(database, session.ownerId) : Promise.resolve(null),
    ]);
    return Response.json({ ...view, status }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
