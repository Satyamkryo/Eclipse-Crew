import { z } from "zod";
import { appendOutboxFiles, listOutboxIndex, serializeMessage } from "@/lib/chat/data";
import { getDatabase } from "@/db/client";
import { requireNoQuery, requireOwnerRequest, RequestError } from "@/lib/auth/request";
import { desktopListOutbox } from "@/lib/desktop/client";
import { NO_STORE, outboxError } from "@/lib/chat/outbox-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const scanning = new Set<string>();

// Finds new files in the agent's outbox/ and adds one file card for each. The chat pane calls this on its poll;
// the agent runtime will call the same functions when a step finishes (TASK-024).
export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  let key: string | null = null;
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const agent = z.string().uuid().safeParse((await params).agentId);
    if (!agent.success) throw new RequestError(400, "invalid_agent");
    const scanKey = `${session.ownerId}:${agent.data}`;
    if (scanning.has(scanKey)) return Response.json({ messages: [], pending: 0 }, { headers: NO_STORE });
    scanning.add(scanKey);
    key = scanKey;
    const database = await getDatabase();
    const index = await listOutboxIndex(database, session.ownerId, agent.data);
    const known = index.slice(0, 500).map((file): [string, number] => [file.name, file.size]);
    const found = await desktopListOutbox(agent.data, session.ownerId, known);
    const created = found.files.length ? await appendOutboxFiles(database, session.ownerId, agent.data, found.files) : [];
    return Response.json({ messages: created.map(serializeMessage), pending: found.pending }, { headers: NO_STORE });
  } catch (error) {
    return outboxError(error);
  } finally { if (key) scanning.delete(key); }
}
