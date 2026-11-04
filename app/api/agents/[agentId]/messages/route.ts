import { z } from "zod";
import { ChatDataError, appendAgentCard, appendUserMessage, listAgentMessages, serializeMessage } from "@/lib/chat/data";
import { listAgentRecords } from "@/lib/agents/data";
import { namesAgent, parseMention } from "@/lib/chat/mentions";
import { recordAuditBestEffort } from "@/lib/security/audit";
import {
  chatHistoryQuerySchema,
  userMessageInputSchema,
  type ChatHistoryQuery,
} from "@/lib/chat/schema";
import { getDatabase } from "@/db/client";
import { startChatRun } from "@/lib/agent/chat-run";
import {
  readBoundedJson,
  requestErrorResponse,
  requireNoQuery,
  requireOwnerRequest,
  RequestError,
} from "@/lib/auth/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseAgentId(params: Promise<{ agentId: string }>) {
  return params.then(({ agentId }) => {
    const parsed = z.string().uuid().safeParse(agentId);
    if (!parsed.success) throw new RequestError(400, "invalid_agent");
    return parsed.data;
  });
}

function parseHistoryQuery(request: Request): ChatHistoryQuery {
  const params = new URL(request.url).searchParams;
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) throw new RequestError(400, "invalid_query");
  const parsed = chatHistoryQuerySchema.safeParse(Object.fromEntries(params));
  if (!parsed.success) throw new RequestError(400, "invalid_query");
  return parsed.data;
}

function chatErrorResponse(error: unknown): Response {
  if (error instanceof ChatDataError) {
    const status = error.code === "agent_not_found" ? 404
      : error.code === "agent_paused" ? 409
        : error.code === "invalid_cursor" || error.code === "invalid_card" ? 400 : 503;
    return Response.json({ error: error.code }, { status });
  }
  return requestErrorResponse(error);
}

export async function GET(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const session = await requireOwnerRequest(request);
    const agentId = await parseAgentId(params);
    const history = await listAgentMessages(await getDatabase(), session.ownerId, agentId, parseHistoryQuery(request));
    return Response.json({
      messages: history.messages.map(serializeMessage),
      hasMore: history.hasMore,
    });
  } catch (error) {
    return chatErrorResponse(error);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const agentId = await parseAgentId(params);
    const parsed = userMessageInputSchema.safeParse(await readBoundedJson(request, 64 * 1024));
    if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400 });
    const database = await getDatabase();
    // TASK-085. A leading `@Name ` routes the owner's message to that teammate's chat and starts its run there.
    const mention = parseMention(parsed.data.text);
    if (mention) {
      const agents = await listAgentRecords(database, session.ownerId);
      const source = agents.find((agent) => agent.id === agentId);
      if (!source) return Response.json({ error: "not_found" }, { status: 404 });
      if (source.status !== "active") return Response.json({ error: "agent_paused" }, { status: 409 });
      const target = agents.find((agent) => namesAgent(agent.name, mention.name));
      if (!target) return Response.json({ error: "mention_not_found" }, { status: 404 });
      if (target.status !== "active") return Response.json({ error: "teammate_unavailable" }, { status: 409 });
      const routed = await appendUserMessage(database, session.ownerId, target.id, mention.text);
      startChatRun(database, session.ownerId, target.id, mention.text, undefined, routed.id);
      await recordAuditBestEffort(database, session.ownerId, {
        kind: "message_mentioned", agentId: target.id, ref: agentId, code: "routed",
      });
      if (target.id === agentId) return Response.json({ message: serializeMessage(routed) }, { status: 201 });
      const notice = await appendAgentCard(database, session.ownerId, agentId, {
        card: { type: "message", text: `Sent to ${target.name}.` }, sourceTag: "system",
      });
      return Response.json({ message: serializeMessage(notice) }, { status: 201 });
    }
    const message = await appendUserMessage(database, session.ownerId, agentId, parsed.data.text);
    // The message is stored; the run answers later with a card and never changes this response.
    startChatRun(database, session.ownerId, agentId, parsed.data.text, undefined, message.id);
    return Response.json({ message: serializeMessage(message) }, { status: 201 });
  } catch (error) {
    return chatErrorResponse(error);
  }
}
