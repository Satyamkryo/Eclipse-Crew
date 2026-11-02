import { z } from "zod";
import { getDatabase } from "@/db/client";
import { requestErrorResponse, requireNoQuery, requireOwnerRequest, RequestError } from "@/lib/auth/request";
import { listScripts, scriptView } from "@/lib/replay/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

// The History tab's "Saved replays": this agent's newest scripts. Another owner's agent simply has none.
export async function GET(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const session = await requireOwnerRequest(request);
    requireNoQuery(request);
    const agentId = z.string().uuid().safeParse((await params).agentId);
    if (!agentId.success) throw new RequestError(400, "invalid_agent");
    const scripts = await listScripts(await getDatabase(), session.ownerId, agentId.data);
    return Response.json({ scripts: scripts.map(scriptView) }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
