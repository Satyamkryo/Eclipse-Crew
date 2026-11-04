import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { messages } from "../../db/schema";

type Database = Awaited<ReturnType<typeof getDatabase>>;

// TASK-086. A memory change applies without asking only when code can prove it came from the owner's own words.
// The model's claim about where a fact came from is never trusted; the quote and the word overlap are checked here.

const MIN_QUOTE_CHARS = 12;
const MIN_COVERAGE = 0.9;
const MAX_SOURCE_CHARS = 12_000;
const STOP = new Set([
  "about", "after", "again", "also", "and", "are", "because", "been", "before", "being", "but", "can", "could", "did", "does",
  "doing", "down", "each", "for", "from", "had", "has", "have", "here", "into", "its", "just", "more", "most", "not", "now",
  "only", "other", "our", "out", "over", "same", "should", "some", "than", "that", "the", "their", "them", "then", "there",
  "these", "they", "this", "those", "through", "under", "until", "very", "was", "were", "what", "when", "where", "which",
  "while", "will", "with", "would", "your",
]);

// Content words: 4+ letters, lower case, stop words removed, a trailing plural s removed.
export function contentWords(text: string): string[] {
  const words: string[] = [];
  for (const match of String(text ?? "").toLowerCase().matchAll(/[\p{L}]{4,}/gu)) {
    let word = match[0];
    if (STOP.has(word)) continue;
    if (word.endsWith("ies") && word.length > 5) word = `${word.slice(0, -3)}y`;
    else if (word.endsWith("s") && !word.endsWith("ss") && word.length > 4) word = word.slice(0, -1);
    if (word.length >= 4 && !STOP.has(word)) words.push(word);
  }
  return [...new Set(words)];
}

// The share of the change's own content words that appear in the quoted owner message. An empty change is 0.
export function coverage(changeText: string, sourceText: string): number {
  const change = contentWords(changeText);
  if (!change.length) return 0;
  const source = new Set(contentWords(sourceText));
  return change.filter((word) => source.has(word)).length / change.length;
}

export interface OriginChange {
  title: string;
  text: string;
  quote?: string | null;
}

export type OriginDecision = { decision: "auto" | "ask"; reason: string; messageId?: string };

// Owner-scoped: only the owner's own `user` messages can prove a fact. Web, email, documents, tool output and the
// agent's replies are never in this table as `user`.
export async function checkOrigin(
  database: Database, ownerId: string, change: OriginChange, mode: "auto" | "ask",
): Promise<OriginDecision> {
  if (mode !== "auto") return { decision: "ask", reason: "mode_ask" };
  const quote = String(change.quote ?? "").trim();
  if (quote.length < MIN_QUOTE_CHARS) return { decision: "ask", reason: "no_quote" };
  const rows = await database.select({ id: messages.id, content: messages.content }).from(messages)
    .where(and(
      eq(messages.ownerId, ownerId), eq(messages.role, "user"),
      sql`position(${quote} in coalesce(${messages.content}->>'text', '')) > 0`,
    ))
    .orderBy(desc(messages.createdAt)).limit(1);
  const source = rows[0] ? String((rows[0].content as { text?: unknown }).text ?? "").slice(0, MAX_SOURCE_CHARS) : "";
  if (!rows[0]) return { decision: "ask", reason: "quote_not_found" };
  // Only the new fact's words count; a replace updates an entry whose old title may not appear in the new message.
  if (coverage(change.text, `${source} ${quote}`) < MIN_COVERAGE) return { decision: "ask", reason: "low_coverage" };
  return { decision: "auto", reason: "owner_quote", messageId: rows[0].id };
}

export const ORIGIN_RULES = { MIN_QUOTE_CHARS, MIN_COVERAGE, MAX_SOURCE_CHARS } as const;
