import { z } from "zod";
import { getDatabase } from "@/db/client";
import { agentDeleteSchema, agentUpdateSchema } from "@/lib/agents/schema";
import { agentErrorResponse } from "@/lib/agents/http";
import { deleteAgentForOwner, updateAgentForOwner } from "@/lib/agents/service";
import { readBoundedJson, requireNoQuery, requireOwnerRequest, RequestError } from "@/lib/auth/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const agentId = await parseAgentId(params);
    const parsed = agentUpdateSchema.safeParse(await readBoundedJson(request, 64 * 1024));
    if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400 });
    await updateAgentForOwner(await getDatabase(), session.ownerId, agentId, parsed.data);
    return Response.json({ ok: true });
  } catch (error) {
    return agentErrorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const agentId = await parseAgentId(params);
    const parsed = agentDeleteSchema.safeParse(await readBoundedJson(request, 4096));
    if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400 });
    await deleteAgentForOwner(await getDatabase(), session.ownerId, agentId, parsed.data.confirmation);
    return Response.json({ ok: true });
  } catch (error) {
    return agentErrorResponse(error);
  }
}

async function parseAgentId(params: Promise<{ agentId: string }>) {
  const parsed = z.string().uuid().safeParse((await params).agentId);
  if (!parsed.success) throw new RequestError(400, "invalid_agent");
  return parsed.data;
}
