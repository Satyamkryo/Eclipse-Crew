import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, lt, or, sql } from "drizzle-orm";
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
  type ChatMessage,
  type ChatRole,
  type ChatSourceTag,
} from "./schema";
import { prepareRoutineCard, RoutineError } from "../routines/data";

type Database = Awaited<ReturnType<typeof getDatabase>>;
export type StoredChatMessage = {
  id: string;
  role: ChatRole;
  card: ChatCard;
  sourceTag: ChatSourceTag;
  runId: string | null;
  createdAt: Date;
};

export function serializeMessage(message: StoredChatMessage): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    card: message.card,
    sourceTag: message.sourceTag,
    runId: message.runId,
    createdAt: message.createdAt.toISOString(),
  };
}

export class ChatDataError extends Error {
  constructor(public code: "agent_not_found" | "agent_paused" | "invalid_card" | "invalid_cursor") {
    super(code);
  }
}

// An agent may only post outbox file cards; inbox cards come from the owner's own upload (appendUserFile).
const agentCardInputSchema = z.object({
  card: chatCardSchema.refine((card) => card.type !== "file" || card.direction === "outbox"),
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

export async function appendUserMessage(database: Database, ownerId: string, agentId: string, text: string, options: { fromAgent?: string } = {}) {
  const agent = await requireAgent(database, ownerId, agentId);
  if (agent.status !== "active") throw new ChatDataError("agent_paused");
  const session = await getOrCreateSession(database, ownerId, agentId);
  const card = chatCardSchema.parse({ type: "message", text, ...(options.fromAgent ? { fromAgent: options.fromAgent } : {}) });
  return insertMessage(database, ownerId, session.id, "user", card, "user", null);
}

export async function requireActiveAgent(database: Database, ownerId: string, agentId: string) {
  const agent = await requireAgent(database, ownerId, agentId);
  if (agent.status !== "active") throw new ChatDataError("agent_paused");
}

export async function appendUserFile(
  database: Database, ownerId: string, agentId: string,
  file: { name: string; size: number; kind: string; sha256: string },
) {
  await requireActiveAgent(database, ownerId, agentId);
  const session = await getOrCreateSession(database, ownerId, agentId);
  const parsed = chatCardSchema.safeParse({ type: "file", direction: "inbox", ...file });
  if (!parsed.success) throw new ChatDataError("invalid_card");
  return insertMessage(database, ownerId, session.id, "user", parsed.data, "user", null);
}

export async function appendAgentCard(
  database: Database, ownerId: string, agentId: string, input: unknown,
  options: { now?: Date } = {},
): Promise<StoredChatMessage> {
  const parsed = agentCardInputSchema.safeParse(input);
  if (!parsed.success) throw new ChatDataError("invalid_card");
  let card = parsed.data.card;
  if (card.type === "routine") {
    try {
      card = prepareRoutineCard(card, { now: options.now ?? new Date() });
    } catch (error) {
      if (error instanceof RoutineError) throw new ChatDataError("invalid_card");
      throw error;
    }
  }
  await requireAgent(database, ownerId, agentId);
  const session = await getOrCreateSession(database, ownerId, agentId);
  const role: ChatRole = parsed.data.sourceTag === "system" ? "system" : "agent";
  return insertMessage(
    database, ownerId, session.id, role, card, parsed.data.sourceTag, parsed.data.runId ?? null,
  );
}

type OutboxCard = Extract<ChatCard, { type: "file" }>;
const MAX_OUTBOX_INDEX = 1000;

// Name and size of every outbox file that already has a card, so the desktop only hashes new files.
export async function listOutboxIndex(database: Database, ownerId: string, agentId: string) {
  await requireAgent(database, ownerId, agentId);
  const session = await findSession(database, ownerId, agentId);
  if (!session) return [];
  const rows = await database.select({ content: messages.content }).from(messages)
    .where(and(eq(messages.ownerId, ownerId), eq(messages.sessionId, session.id), eq(messages.cardType, "file"), sql`${messages.content}->>'direction' = 'outbox'`))
    .orderBy(desc(messages.createdAt)).limit(MAX_OUTBOX_INDEX);
  return rows.flatMap((row) => {
    const card = chatCardSchema.safeParse(row.content);
    return card.success && card.data.type === "file" ? [{ name: card.data.name, size: card.data.size, sha256: card.data.sha256 }] : [];
  });
}

// Outbox cards come only from the desktop scan result (never from model output). The file is the agent's, so the
// card is an agent message tagged "tool": its name and contents are untrusted data.
export async function appendOutboxFiles(
  database: Database, ownerId: string, agentId: string, files: { name: string; size: number; kind: string; sha256: string }[],
  runId: string | null = null,
) {
  const existing = await listOutboxIndex(database, ownerId, agentId);
  const seen = new Set(existing.map((file) => `${file.name}\u0000${file.sha256}`));
  const session = await getOrCreateSession(database, ownerId, agentId);
  const created: StoredChatMessage[] = [];
  for (const file of files) {
    const key = `${file.name}\u0000${file.sha256}`;
    if (seen.has(key)) continue;
    const parsed = chatCardSchema.safeParse({ type: "file", direction: "outbox", ...file });
    if (!parsed.success) continue;
    seen.add(key);
    created.push(await insertMessage(database, ownerId, session.id, "agent", parsed.data, "tool", runId));
  }
  return created;
}

export async function getOutboxFileCard(database: Database, ownerId: string, agentId: string, messageId: string): Promise<OutboxCard | null> {
  await requireAgent(database, ownerId, agentId);
  const session = await findSession(database, ownerId, agentId);
  if (!session) return null;
  const rows = await database.select({ content: messages.content }).from(messages)
    .where(and(eq(messages.ownerId, ownerId), eq(messages.sessionId, session.id), eq(messages.id, messageId), eq(messages.cardType, "file"))).limit(1);
  const card = chatCardSchema.safeParse(rows[0]?.content);
  return card.success && card.data.type === "file" && card.data.direction === "outbox" ? card.data : null;
}
