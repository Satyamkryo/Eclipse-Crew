import { z } from "zod";
import { getDatabase } from "@/db/client";
import { generateSkillDraft, SkillError } from "@/lib/skills/generate";
import { serializeSkill } from "@/lib/skills/store";
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
const active = new Set<string>();
const lastStarted = new Map<string, number>();

function skillErrorResponse(error: unknown): Response {
  if (error instanceof SkillError) {
    const status = error.code === "capture_not_found" ? 404
      : error.code === "skill_conflict" || error.code === "capture_not_complete" || error.code === "budget_paused" ? 409
        : error.code === "no_model" || error.code === "price_required" ? 400
          : error.code === "provider_error" || error.code === "cleanup_failed" ? 503 : 422;
    return Response.json({ error: error.code }, { status, headers: { "Cache-Control": "no-store" } });
  }
  const response = requestErrorResponse(error);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

export async function POST(request: Request, { params }: { params: Promise<{ captureId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const captureId = z.string().uuid().safeParse((await params).captureId);
    if (!captureId.success) throw new RequestError(400, "invalid_capture");
    const parsed = bodySchema.safeParse(await readBoundedJson(request, 4096));
    if (!parsed.success) throw new RequestError(400, "invalid_input");
    if (active.has(session.ownerId) || Date.now() - (lastStarted.get(session.ownerId) ?? 0) < 5000) {
      return Response.json({ error: "generation_busy" }, { status: 429, headers: { "Cache-Control": "no-store" } });
    }
    active.add(session.ownerId);
    lastStarted.set(session.ownerId, Date.now());
    try {
      const skill = await generateSkillDraft({ database: await getDatabase(), ownerId: session.ownerId, captureId: captureId.data });
      return Response.json({ skill: serializeSkill(skill) }, { status: 201, headers: { "Cache-Control": "no-store" } });
    } finally {
      active.delete(session.ownerId);
    }
  } catch (error) {
    return skillErrorResponse(error);
  }
}
