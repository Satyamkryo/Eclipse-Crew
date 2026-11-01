import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, lt, or } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "../../db/client";
import { chatSessions, messages } from "../../db/schema";
import { getAgentIdentity } from "../agents/data";
import {
  CHAT_PAGE_SIZE,
  chatCardSchema,
  chatRoleSchema,
  chatSourceTagSchema,
  type ChatCard,
  type ChatHistoryQuery,
  type ChatRole,
  type ChatSourceTag,
} from "./schema";

type Database = Awaited<ReturnType<typeof getDatabase>>;
export type StoredChatMessage = {
  id: string;
  role: ChatRole;
  card: ChatCard;
  sourceTag: ChatSourceTag;
  runId: string | null;
  createdAt: Date;
};

export class ChatDataError extends Error {
  constructor(public code: "agent_not_found" | "agent_paused" | "invalid_card" | "invalid_cursor") {
    super(code);
  }
}

const agentCardInputSchema = z.object({
  card: chatCardSchema,
  sourceTag: z.enum(["agent", "tool", "system"]).default("agent"),
  runId: z.string().uuid().nullable().optional(),
}).strict();

const messageFields = {
  id: messages.id,
  role: messages.role,
  cardType: messages.cardType,
  content: messages.content,
  sourceTag: messages.sourceTag,
  runId: messages.runId,
  createdAt: messages.createdAt,
};

type MessageRow = {
  id: string;
  role: string;
  cardType: string;
  content: unknown;
  sourceTag: string;
  runId: string | null;
  createdAt: Date;
};

function toMessage(row: MessageRow): StoredChatMessage {
  const card = chatCardSchema.safeParse(row.content);
  const role = chatRoleSchema.safeParse(row.role);
  const sourceTag = chatSourceTagSchema.safeParse(row.sourceTag);
  if (!card.success || card.data.type !== row.cardType || !role.success || !sourceTag.success)
    throw new ChatDataError("invalid_card");
  return { id: row.id, role: role.data, card: card.data, sourceTag: sourceTag.data, runId: row.runId, createdAt: row.createdAt };
}

async function requireAgent(database: Database, ownerId: string, agentId: string) {
  const agent = await getAgentIdentity(database, ownerId, agentId);
  if (!agent) throw new ChatDataError("agent_not_found");
  return agent;
}

async function findSession(database: Database, ownerId: string, agentId: string) {
  const rows = await database.select({ id: chatSessions.id }).from(chatSessions)
    .where(and(eq(chatSessions.ownerId, ownerId), eq(chatSessions.agentId, agentId))).limit(1);
  return rows[0];
}

async function getOrCreateSession(database: Database, ownerId: string, agentId: string) {
  const existing = await findSession(database, ownerId, agentId);
  if (existing) return existing;
  await database.insert(chatSessions).values({ id: randomUUID(), ownerId, agentId })
    .onConflictDoNothing({ target: [chatSessions.ownerId, chatSessions.agentId] });
  const created = await findSession(database, ownerId, agentId);
  if (!created) throw new ChatDataError("agent_not_found");
  return created;
}

async function insertMessage(
  database: Database, ownerId: string, sessionId: string, role: ChatRole, card: ChatCard,
  sourceTag: ChatSourceTag, runId: string | null,
) {
  const rows = await database.insert(messages).values({
    id: randomUUID(),
    ownerId,
    sessionId,
    role,
    cardType: card.type,
    content: card,
    sourceTag,
    runId,
  }).returning(messageFields);
  const row = rows[0];
  if (!row) throw new ChatDataError("invalid_card");
  return toMessage(row);
}

export async function listAgentMessages(
  database: Database, ownerId: string, agentId: string, query: ChatHistoryQuery = {},
): Promise<{ messages: StoredChatMessage[]; hasMore: boolean }> {
  await requireAgent(database, ownerId, agentId);
  const session = await findSession(database, ownerId, agentId);
  if (!session) return { messages: [], hasMore: false };

  let cursor: { id: string; createdAt: Date } | undefined;
  let rows;
  if (query.before || query.after) {
    const id = query.before ?? query.after ?? "";
    const cursorRows = await database.select({ id: messages.id, createdAt: messages.createdAt }).from(messages)
      .where(and(eq(messages.ownerId, ownerId), eq(messages.sessionId, session.id), eq(messages.id, id))).limit(1);
    cursor = cursorRows[0];
    if (!cursor) throw new ChatDataError("invalid_cursor");
  }

  if (query.after && cursor) {
    rows = await database.select(messageFields).from(messages)
      .where(and(
        eq(messages.ownerId, ownerId),
        eq(messages.sessionId, session.id),
        or(
          gt(messages.createdAt, cursor.createdAt),
          and(eq(messages.createdAt, cursor.createdAt), gt(messages.id, cursor.id)),
        ),
      ))
      .orderBy(asc(messages.createdAt), asc(messages.id)).limit(CHAT_PAGE_SIZE + 1);
  } else if (query.before && cursor) {
    rows = await database.select(messageFields).from(messages)
      .where(and(
        eq(messages.ownerId, ownerId),
        eq(messages.sessionId, session.id),
        or(
          lt(messages.createdAt, cursor.createdAt),
          and(eq(messages.createdAt, cursor.createdAt), lt(messages.id, cursor.id)),
        ),
      ))
      .orderBy(desc(messages.createdAt), desc(messages.id)).limit(CHAT_PAGE_SIZE + 1);
    rows.reverse();
  } else {
    rows = await database.select(messageFields).from(messages)
      .where(and(eq(messages.ownerId, ownerId), eq(messages.sessionId, session.id)))
      .orderBy(desc(messages.createdAt), desc(messages.id)).limit(CHAT_PAGE_SIZE + 1);
    rows.reverse();
  }

  const hasMore = rows.length > CHAT_PAGE_SIZE;
  const page = query.after ? rows.slice(0, CHAT_PAGE_SIZE) : rows.slice(-CHAT_PAGE_SIZE);
  return { messages: page.map(toMessage), hasMore };
}

export async function appendUserMessage(database: Database, ownerId: string, agentId: string, text: string) {
  const agent = await requireAgent(database, ownerId, agentId);
  if (agent.status !== "active") throw new ChatDataError("agent_paused");
  const session = await getOrCreateSession(database, ownerId, agentId);
  const card = chatCardSchema.parse({ type: "message", text });
  return insertMessage(database, ownerId, session.id, "user", card, "user", null);
}

export async function appendAgentCard(
  database: Database, ownerId: string, agentId: string, input: unknown,
): Promise<StoredChatMessage> {
  const parsed = agentCardInputSchema.safeParse(input);
  if (!parsed.success) throw new ChatDataError("invalid_card");
  await requireAgent(database, ownerId, agentId);
  const session = await getOrCreateSession(database, ownerId, agentId);
  const role: ChatRole = parsed.data.sourceTag === "system" ? "system" : "agent";
  return insertMessage(
    database, ownerId, session.id, role, parsed.data.card, parsed.data.sourceTag, parsed.data.runId ?? null,
  );
}
