import { z } from "zod";
import { getDatabase } from "@/db/client";
import { getAgentRecord } from "@/lib/agents/data";
import { readBoundedJson, requestErrorResponse, requireNoQuery, requireOwnerRequest, RequestError } from "@/lib/auth/request";
import { startReplay } from "@/lib/replay/ports";
import { matchInputs, replayInputsSchema } from "@/lib/replay/script";
import { getScript } from "@/lib/replay/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
// Up to 20 steps of 2,000 characters each, so larger than the other replay routes.
const MAX_BODY = 64 * 1024;
const bodySchema = z.object({ inputs: replayInputsSchema }).strict();

// Starts one replay and returns at once; the result arrives as a chat card and a run in History. The text for `type` steps
// travels only in this request body and is never stored.
export async function POST(request: Request, { params }: { params: Promise<{ scriptId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const scriptId = z.string().uuid().safeParse((await params).scriptId);
    if (!scriptId.success) throw new RequestError(400, "invalid_script");
    const body = bodySchema.safeParse(await readBoundedJson(request, MAX_BODY));
    if (!body.success) return Response.json({ error: "invalid_input" }, { status: 400, headers: NO_STORE });
    const database = await getDatabase();
    const script = await getScript(database, session.ownerId, scriptId.data);
    if (!script) return Response.json({ error: "script_not_found" }, { status: 404, headers: NO_STORE });
    const inputs = matchInputs(script.steps, body.data.inputs);
    if (!inputs) return Response.json({ error: "invalid_input" }, { status: 400, headers: NO_STORE });
    const agent = await getAgentRecord(database, session.ownerId, script.agentId);
    if (!agent || agent.status !== "active") return Response.json({ error: "agent_unavailable" }, { status: 409, headers: NO_STORE });
    startReplay(database, session.ownerId, script, inputs);
    return Response.json({ status: "started" }, { status: 202, headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
