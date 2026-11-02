import { z } from "zod";
import { getDatabase } from "@/db/client";
import { approveSkill, SkillStoreError } from "@/lib/skills/store";
import {
  readBoundedJson,
  requestErrorResponse,
  requireNoQuery,
  requireOwnerRequest,
  RequestError,
} from "@/lib/auth/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({}).strict();

function errorResponse(error: unknown): Response {
  if (error instanceof SkillStoreError) {
    const status = error.code === "skill_not_found" ? 404 : 503;
    return Response.json({ error: error.code }, { status, headers: { "Cache-Control": "no-store" } });
  }
  const response = requestErrorResponse(error);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

export async function POST(request: Request, { params }: { params: Promise<{ skillId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const skillId = z.string().uuid().safeParse((await params).skillId);
    if (!skillId.success) throw new RequestError(400, "invalid_skill");
    const parsed = bodySchema.safeParse(await readBoundedJson(request, 4096));
    if (!parsed.success) throw new RequestError(400, "invalid_input");
    const skill = await approveSkill(await getDatabase(), session.ownerId, skillId.data);
    return Response.json({ skill }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
