import { z } from "zod";
import { getDatabase } from "@/db/client";
import { confirmRoutine, readRoutineForMessage, RoutineError } from "@/lib/routines/data";
import { routineConfirmInputSchema } from "@/lib/routines/schema";
import {
  readBoundedJson,
  requestErrorResponse,
  requireNoQuery,
  requireOwnerRequest,
  RequestError,
} from "@/lib/auth/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ agentId: z.string().uuid(), messageId: z.string().uuid() }).strict();

function parseParams(params: Promise<{ agentId: string; messageId: string }>) {
  return params.then((value) => {
    const parsed = paramsSchema.safeParse(value);
    if (!parsed.success) throw new RequestError(400, "invalid_routine");
    return parsed.data;
  });
}

function routineErrorResponse(error: unknown): Response {
  if (error instanceof RoutineError) {
    const status = error.code === "routine_not_found" ? 404
      : error.code === "skill_not_available" ? 409 : 400;
    return Response.json({ error: error.code }, { status, headers: { "Cache-Control": "no-store" } });
  }
  const response = requestErrorResponse(error);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

export async function GET(request: Request, { params }: { params: Promise<{ agentId: string; messageId: string }> }) {
  try {
    const session = await requireOwnerRequest(request);
    requireNoQuery(request);
    const { agentId, messageId } = await parseParams(params);
    const routine = await readRoutineForMessage(await getDatabase(), session.ownerId, agentId, messageId);
    return Response.json({ routine }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return routineErrorResponse(error);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ agentId: string; messageId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const { agentId, messageId } = await parseParams(params);
    const parsed = routineConfirmInputSchema.safeParse(await readBoundedJson(request, 4 * 1024));
    if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    const routine = await confirmRoutine(await getDatabase(), session.ownerId, agentId, messageId);
    return Response.json({ routine }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return routineErrorResponse(error);
  }
}
