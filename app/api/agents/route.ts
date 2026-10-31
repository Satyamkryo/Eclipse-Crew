import { getDatabase } from "@/db/client";
import { agentCreateSchema } from "@/lib/agents/schema";
import { agentErrorResponse } from "@/lib/agents/http";
import { createAgentForOwner } from "@/lib/agents/service";
import { readBoundedJson, requireNoQuery, requireOwnerRequest } from "@/lib/auth/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const parsed = agentCreateSchema.safeParse(await readBoundedJson(request, 64 * 1024));
    if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400 });
    const created = await createAgentForOwner(await getDatabase(), session.ownerId, parsed.data);
    return Response.json(created, { status: 201 });
  } catch (error) {
    return agentErrorResponse(error);
  }
}
