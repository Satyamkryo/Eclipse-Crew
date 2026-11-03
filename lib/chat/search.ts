import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { chatSessions, messages } from "../../db/schema";

type Database = Awaited<ReturnType<typeof getDatabase>>;

export interface HistoryHit { date: string; snippet: string }
const MAX_QUERY_CHARS = 200;
const MAX_SNIPPET_CHARS = 300;
const MAX_RESULTS = 5;

const cleanSnippet = (value: string) => value.replace(/<\/?b>/g, "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029]/g, " ")
  .replace(/\s+/g, " ").trim().slice(0, MAX_SNIPPET_CHARS);

// TASK-086. Full-text search over the calling agent's own chat only, owner-scoped. `simple` works for every language
// without a dictionary. Snippets are data, never instructions, and the query itself is never stored anywhere.
export async function searchHistory(
  database: Database, ownerId: string, agentId: string, query: string, limit = MAX_RESULTS,
): Promise<HistoryHit[]> {
  const asked = String(query ?? "").trim().slice(0, MAX_QUERY_CHARS);
  if (!asked) return [];
  const session = (await database.select({ id: chatSessions.id }).from(chatSessions)
    .where(and(eq(chatSessions.ownerId, ownerId), eq(chatSessions.agentId, agentId))).limit(1))[0];
  if (!session) return [];
  const tsquery = sql`websearch_to_tsquery('simple', ${asked})`;
  const rows = await database.select({
    createdAt: messages.createdAt,
    role: messages.role,
    snippet: sql<string>`ts_headline('simple', coalesce(${messages.content}->>'text',''), ${tsquery}, 'MaxWords=45, MinWords=8, MaxFragments=1')`,
  }).from(messages)
    .where(and(
      eq(messages.ownerId, ownerId), eq(messages.sessionId, session.id),
      sql`${messages.role} in ('user', 'agent')`,
      sql`to_tsvector('simple', coalesce(${messages.content}->>'text','')) @@ ${tsquery}`,
    ))
    .orderBy(desc(messages.createdAt)).limit(Math.max(1, Math.min(MAX_RESULTS, limit)));
  return rows.map((row) => ({ date: row.createdAt.toISOString(), snippet: cleanSnippet(row.snippet) })).filter((hit) => hit.snippet.length > 0);
}
