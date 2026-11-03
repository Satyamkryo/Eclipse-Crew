import { z } from "zod";
import { getDatabase } from "@/db/client";
import { agentErrorResponse } from "@/lib/agents/http";
import { desktopStatusForOwner, startBrowserForOwner, startDesktopForOwner, stopBrowserForOwner, stopDesktopForOwner } from "@/lib/agents/service";
import { readBoundedJson, requireNoQuery, requireOwnerRequest, RequestError } from "@/lib/auth/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const actionSchema = z.object({ action: z.enum(["start", "stop", "start-browser", "stop-browser"]) }).strict();

function agentIdFrom(params: { agentId: string }): string {
  const parsed = z.string().uuid().safeParse(params.agentId);
  if (!parsed.success) throw new RequestError(400, "invalid_agent");
  return parsed.data;
}

export async function GET(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const session = await requireOwnerRequest(request);
    requireNoQuery(request);
    const status = await desktopStatusForOwner(await getDatabase(), session.ownerId, agentIdFrom(await params));
    return Response.json({ agentId: status.agentId, state: status.state, sandbox: status.sandbox, graphics: status.graphics,
      browser: status.browser, ...(status.generation ? { generation: status.generation } : {}),
      ...(status.reason ? { reason: status.reason } : {}), ...(status.display === undefined ? {} : { display: status.display }) });
  } catch (error) {
    return agentErrorResponse(error);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const agentId = agentIdFrom(await params);
    const { action } = actionSchema.parse(await readBoundedJson(request));
    const database = await getDatabase();
    if (action === "start") await startDesktopForOwner(database, session.ownerId, agentId);
    else if (action === "stop") await stopDesktopForOwner(database, session.ownerId, agentId);
    else if (action === "start-browser") await startBrowserForOwner(database, session.ownerId, agentId);
    else await stopBrowserForOwner(database, session.ownerId, agentId);
    return Response.json({ status: action });
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: "invalid_action" }, { status: 400 });
    return agentErrorResponse(error);
  }
}
