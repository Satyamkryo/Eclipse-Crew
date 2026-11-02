import { z } from "zod";
import { getDatabase } from "@/db/client";
import { requireOwnedAgent } from "@/lib/agents/access";
import { readBoundedJson, requireNoQuery, requireOwnerRequest, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { teachControl } from "@/lib/teach/schema";
import { controlCapture, listCaptures, narrationAllowed } from "@/lib/teach/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const session = await requireOwnerRequest(request); requireNoQuery(request);
    const id = z.string().uuid().safeParse((await params).agentId);
    if (!id.success) throw new RequestError(400, "invalid_agent");
    await requireOwnedAgent(session.ownerId, id.data);
    const database = await getDatabase();
    return Response.json({ narrationAllowed: await narrationAllowed(database, session.ownerId),
      captures: await listCaptures(database, session.ownerId, id.data) });
  } catch (error) { return requestErrorResponse(error); }
}
export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true }); requireNoQuery(request);
    const id = z.string().uuid().safeParse((await params).agentId);
    const parsed = teachControl.safeParse(await readBoundedJson(request));
    if (!id.success || !parsed.success) throw new RequestError(400, "invalid_teach_control");
    await requireOwnedAgent(session.ownerId, id.data);
    return Response.json(await controlCapture(await getDatabase(), session, id.data, parsed.data));
  } catch (error) { return requestErrorResponse(error); }
}
