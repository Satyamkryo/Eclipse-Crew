import { z } from "zod";
import { getDatabase } from "@/db/client";
import { readBoundedJson, requireNoQuery, requireOwnerRequest, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { decideMemoryChange } from "@/lib/memory/changes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const bodySchema = z.object({ decision: z.enum(["approve", "reject"]) }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ changeId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const changeId = z.string().uuid().safeParse((await params).changeId);
    if (!changeId.success) throw new RequestError(400, "invalid_change");
    const body = bodySchema.safeParse(await readBoundedJson(request, 4096));
    if (!body.success) return Response.json({ error: "invalid_input" }, { status: 400, headers: NO_STORE });
    const result = await decideMemoryChange(await getDatabase(), session.ownerId, changeId.data, body.data.decision);
    if (!result.ok) {
      const status = result.error === "not_found" ? 404 : result.error === "expired" || result.error === "already_decided" ? 409 : 409;
      return Response.json({ error: result.error }, { status, headers: NO_STORE });
    }
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
