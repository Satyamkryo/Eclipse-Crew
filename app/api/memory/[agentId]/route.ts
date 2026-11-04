import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "@/db/client";
import { agentPolicies } from "@/db/schema";
import { requireNoQuery, requireOwnerRequest, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { getMirrorStatus } from "@/lib/memory/mirror";
import { listMemory } from "@/lib/memory/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function GET(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const session = await requireOwnerRequest(request);
    requireNoQuery(request);
    const agentId = z.string().uuid().safeParse((await params).agentId);
    if (!agentId.success) throw new RequestError(400, "invalid_agent");
    const database = await getDatabase();
    const documents = await listMemory(database, session.ownerId, agentId.data);
    return Response.json({ ...documents, mirror: getMirrorStatus(session.ownerId, agentId.data) }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}

const modeBodySchema = z.object({ mode: z.enum(["auto", "ask"]) }).strict();

export async function PATCH(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const agentId = z.string().uuid().safeParse((await params).agentId);
    if (!agentId.success) throw new RequestError(400, "invalid_agent");
    const body = modeBodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) throw new RequestError(400, "invalid_request");
    const updated = await (await getDatabase()).update(agentPolicies)
      .set({ memoryMode: body.data.mode, updatedAt: new Date() })
      .where(and(eq(agentPolicies.ownerId, session.ownerId), eq(agentPolicies.agentId, agentId.data)))
      .returning({ agentId: agentPolicies.agentId });
    if (!updated[0]) throw new RequestError(404, "agent_not_found");
    return Response.json({ mode: body.data.mode }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
