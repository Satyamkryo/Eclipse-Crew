import { z } from "zod";
import { getDatabase } from "@/db/client";
import { readBoundedJson, requestErrorResponse, requireNoQuery, requireOwnerRequest, RequestError } from "@/lib/auth/request";
import { checkInInputSchema } from "@/lib/check-ins/logic";
import { createCheckIn, listCheckIns } from "@/lib/check-ins/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

function withHeaders(response: Response): Response {
  for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
  return response;
}

async function agentIdFrom(params: Promise<{ agentId: string }>): Promise<string> {
  const parsed = z.string().uuid().safeParse((await params).agentId);
  if (!parsed.success) throw new RequestError(400, "invalid_agent");
  return parsed.data;
}

// Sundance / Moondance check-ins for one agent. Owner-only; every query is scoped by owner and agent.
export async function GET(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const session = await requireOwnerRequest(request);
    requireNoQuery(request);
    const checkIns = await listCheckIns(await getDatabase(), session.ownerId, await agentIdFrom(params));
    return Response.json({ checkIns }, { headers: NO_STORE });
  } catch (error) {
    return withHeaders(requestErrorResponse(error));
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const agentId = await agentIdFrom(params);
    const body = checkInInputSchema.safeParse(await readBoundedJson(request, 8192));
    if (!body.success) {
      const code = body.error.issues.find((issue) => issue.message === "invalid_url" || issue.message === "invalid_window")?.message ?? "invalid_input";
      return Response.json({ error: code }, { status: 400, headers: NO_STORE });
    }
    const checkIn = await createCheckIn(await getDatabase(), session.ownerId, agentId, body.data);
    return Response.json({ checkIn }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return withHeaders(requestErrorResponse(error));
  }
}
