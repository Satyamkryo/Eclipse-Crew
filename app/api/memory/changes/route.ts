import { z } from "zod";
import { getDatabase } from "@/db/client";
import { requireOwnerRequest, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { listPending } from "@/lib/memory/changes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const querySchema = z.object({ agent: z.string().uuid().optional() }).strict();

export async function GET(request: Request) {
  try {
    const session = await requireOwnerRequest(request);
    const url = new URL(request.url);
    const query = querySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!query.success) throw new RequestError(400, "invalid_query");
    const changes = await listPending(await getDatabase(), session.ownerId, query.data.agent);
    return Response.json({ changes }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
