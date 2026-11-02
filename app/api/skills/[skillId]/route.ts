import { z } from "zod";
import { getDatabase } from "@/db/client";
import { ownedSkill, serializeSkill, SkillStoreError } from "@/lib/skills/store";
import { requireNoQuery, requireOwnerRequest, requestErrorResponse, RequestError } from "@/lib/auth/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown): Response {
  if (error instanceof SkillStoreError) {
    return Response.json({ error: error.code }, { status: error.code === "skill_not_found" ? 404 : 503, headers: { "Cache-Control": "no-store" } });
  }
  const response = requestErrorResponse(error);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

export async function GET(request: Request, { params }: { params: Promise<{ skillId: string }> }) {
  try {
    const session = await requireOwnerRequest(request);
    requireNoQuery(request);
    const skillId = z.string().uuid().safeParse((await params).skillId);
    if (!skillId.success) throw new RequestError(400, "invalid_skill");
    const skill = await ownedSkill(await getDatabase(), session.ownerId, skillId.data);
    return Response.json({ skill: serializeSkill(skill) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
