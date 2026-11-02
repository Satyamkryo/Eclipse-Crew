import { z } from "zod";
import { getDatabase } from "@/db/client";
import { requireOwnerRequest, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { memoryHistoryQuerySchema } from "@/lib/memory/schema";
import { listHistory } from "@/lib/memory/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const docKey = z.string().regex(/^(user|agent:[0-9a-f-]{36}:(memory|private|soul))$/);

export async function GET(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const session = await requireOwnerRequest(request);
    const agentId = z.string().uuid().safeParse((await params).agentId);
    if (!agentId.success) throw new RequestError(400, "invalid_agent");
    const url = new URL(request.url);
    const query = memoryHistoryQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!query.success || !docKey.safeParse(query.data.doc).success) {
      return Response.json({ error: "invalid_query" }, { status: 400, headers: NO_STORE });
    }
    // The document must belong to the selected agent; the owner cannot read another agent's key through this route.
    if (query.data.doc !== "user" && !query.data.doc.startsWith(`agent:${agentId.data}:`)) {
      return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    }
    const versions = await listHistory(await getDatabase(), session.ownerId, query.data.doc);
    return Response.json({ versions }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
