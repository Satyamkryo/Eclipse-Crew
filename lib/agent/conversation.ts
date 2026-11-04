import "server-only";

import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import type { getDatabase } from "../../db/client";
import { chatSessions, messages } from "../../db/schema";
import { chatCardSchema } from "../chat/schema";
import { cleanText } from "../receipts/chain.mjs";
import type { ProviderContent } from "../providers/types";

type Database = Awaited<ReturnType<typeof getDatabase>>;
const MAX_MESSAGES = 10;
const MAX_CHARS = 6000;
const MAX_MESSAGE_CHARS = 1500;
const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ConversationRow {
  id: string;
  role: string;
  content: unknown;
  createdAt: Date;
}

function cardText(content: unknown): string | null {
  const parsed = chatCardSchema.safeParse(content);
  if (!parsed.success) return null;
  const card = parsed.data as unknown as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const cardType = parsed.data.type;
  switch (cardType) {
    case "message": return text(card.text);
    case "clarification": return [text(card.question), Array.isArray(card.options) ? card.options.join(" / ") : ""].filter(Boolean).join(" — ");
    case "file": return `[file: ${text(card.direction) || "file"}: ${text(card.name)}]`;
    case "approval": return `[approval: ${text(card.actionClass)} · ${text(card.site)} · ${text(card.decision)}]`;
    case "routine": return `[routine: ${text(card.name) || text(card.title) || "saved"}]`;
    case "skill_update": return `[skill: ${text(card.name) || "update"}]`;
    case "budget_warning": return `[budget: ${text(card.period) || "warning"}]`;
    case "budget_paused": return `[budget: ${text(card.period) || "paused"}]`;
    case "tool_connection": return `[connection: ${text(card.server) || "tool"}]`;
    case "teach_paused": return "[teach paused]";
    case "memory_change":
    case "memory_saved":
    case "memory_tidied": return `[memory: ${text(card.title) || cardType}]`;
    default: return "[card]";
  }
}

// Pure formatter. Rows are oldest first; each is cut to 1,500 characters and the total keeps the
// newest entries within 6,000 characters. Owner text is `user`; agent cards are data (`agent`).
export function conversationParts(rows: readonly ConversationRow[]): { parts: ProviderContent[]; ownerTexts: string[] } {
  const entries = rows.flatMap((row) => {
    const text = cardText(row.content);
    if (!text || text.trim().length === 0) return [];
    return [{ role: row.role === "user" ? "user" as const : "agent" as const, text: cleanText(text.trim(), MAX_MESSAGE_CHARS) }];
  }).slice(-MAX_MESSAGES);
  const kept: typeof entries = [];
  let total = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const remaining = MAX_CHARS - total;
    if (remaining <= 0) break;
    const entry = entries[i];
    if (!entry) continue;
    const text = entry.text.slice(0, Math.min(MAX_MESSAGE_CHARS, remaining));
    if (!text) break;
    kept.unshift({ ...entry, text });
    total += text.length + 1;
  }
  const parts: ProviderContent[] = kept.length ? [{
    type: "text", sourceTag: "user",
    text: "Earlier conversation, for context only. The task is the owner's latest message. Do not repeat earlier actions unless the latest message asks for it.",
  }] : [];
  for (const entry of kept) parts.push({ type: "text", text: entry.text, sourceTag: entry.role });
  return { parts, ownerTexts: kept.filter((entry) => entry.role === "user").map((entry) => entry.text) };
}

export async function loadConversation(
  database: Database, ownerId: string, agentId: string,
  options: { before?: Date; excludeMessageId?: string; now?: Date } = {},
): Promise<{ parts: ProviderContent[]; ownerTexts: string[] }> {
  const session = await database.select({ id: chatSessions.id }).from(chatSessions)
    .where(and(eq(chatSessions.ownerId, ownerId), eq(chatSessions.agentId, agentId))).limit(1);
  if (!session[0]) return { parts: [], ownerTexts: [] };
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - WINDOW_MS);
  const conditions = [eq(messages.ownerId, ownerId), eq(messages.sessionId, session[0].id),
    inArray(messages.role, ["user", "agent"]), gte(messages.createdAt, cutoff)];
  if (options.before) conditions.push(lt(messages.createdAt, options.before));
  const rows = await database.select({ id: messages.id, role: messages.role, content: messages.content, createdAt: messages.createdAt })
    .from(messages).where(and(...conditions)).orderBy(desc(messages.createdAt), desc(messages.id)).limit(MAX_MESSAGES + 10);
  return conversationParts(rows.filter((row) => row.id !== options.excludeMessageId).slice(0, MAX_MESSAGES).reverse());
}
