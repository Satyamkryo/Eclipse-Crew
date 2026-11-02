import "server-only";
import { randomUUID } from "node:crypto";

import type { getDatabase } from "../../db/client";
import { securityEvents } from "../../db/schema";
import type { ScopeRule } from "../agent/scope";

type Database = Awaited<ReturnType<typeof getDatabase>>;

const SOURCE: Record<ScopeRule, "scope_host" | "scope_recipient" | "scope_page"> = {
  host: "scope_host",
  recipient: "scope_recipient",
  page: "scope_page",
};

// TASK-049. One append-only row per refused step. Fixed columns only: no text, URL or host. A failed write is logged as
// a fixed line and never stops the run, because the refusal itself already happened.
export async function recordScopeBlocked(
  database: Database, ownerId: string, agentId: string, runId: string | null, rule: ScopeRule,
): Promise<void> {
  try {
    await database.insert(securityEvents).values({
      id: randomUUID(), ownerId, agentId, kind: "scope_blocked", source: SOURCE[rule], runId, sourceRef: null,
    });
  } catch {
    console.warn("scope block could not be recorded");
  }
}
