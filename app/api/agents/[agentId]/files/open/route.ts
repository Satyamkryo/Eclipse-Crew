import { z } from "zod";
import { getDatabase } from "@/db/client";
import { readBoundedJson, requireNoQuery, requireOwnerRequest, RequestError } from "@/lib/auth/request";
import { getOutboxFileCard } from "@/lib/chat/data";
import { canOpenOnDesktop } from "@/lib/chat/file-types";
import { desktopCommand, desktopSession } from "@/lib/desktop/client";
import { NO_STORE, outboxError } from "@/lib/chat/outbox-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Shows an outbox file in a new tab of the agent's own browser, so the owner can watch it in the live view.
// Only safe kinds open; the desktop checks the file again before navigating.
export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const agent = z.string().uuid().safeParse((await params).agentId);
    if (!agent.success) throw new RequestError(400, "invalid_agent");
    const body = z.object({ messageId: z.string().uuid() }).strict().safeParse(await readBoundedJson(request, 1024));
    if (!body.success) throw new RequestError(400, "invalid_input");
    const card = await getOutboxFileCard(await getDatabase(), session.ownerId, agent.data, body.data.messageId);
    if (!card) return Response.json({ error: "file_not_found" }, { status: 404, headers: NO_STORE });
    if (!canOpenOnDesktop(card.name, card.kind)) return Response.json({ error: "type_blocked" }, { status: 415, headers: NO_STORE });
    const status = await desktopSession(agent.data, session.ownerId, "session.status");
    if (status.state !== "running" || status.browser !== "running" || !status.generation)
      return Response.json({ error: "session_not_running" }, { status: 409, headers: NO_STORE });
    await desktopCommand(agent.data, session.ownerId, status.generation, "file.open", { name: card.name });
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return outboxError(error);
  }
}
