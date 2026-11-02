import "server-only";
import { randomUUID } from "node:crypto";

import type { getDatabase } from "../../db/client";
import { securityEvents } from "../../db/schema";
import type { ScopeRule } from "../agent/scope";
import { recordAudit, type AuditExecutor } from "./audit";

type Database = Awaited<ReturnType<typeof getDatabase>>;

const SOURCE: Record<ScopeRule, "scope_host" | "scope_recipient" | "scope_page"> = {
  host: "scope_host",
  recipient: "scope_recipient",
  page: "scope_page",
};

// TASK-049/052. One append-only row per refused step. Fixed columns only: no text, URL or host. The event and its audit
// entry commit together; a failed write is logged as a fixed line and never stops the run.
export async function recordScopeBlocked(
  database: Database, ownerId: string, agentId: string, runId: string | null, rule: ScopeRule,
): Promise<void> {
  try {
    await database.transaction(async (transaction) => {
      await transaction.insert(securityEvents).values({
        id: randomUUID(), ownerId, agentId, kind: "scope_blocked", source: SOURCE[rule], runId, sourceRef: null,
      });
      await recordAudit(transaction as unknown as AuditExecutor, ownerId, {
        kind: "scope_blocked", agentId, runId, code: SOURCE[rule],
      });
    });
  } catch {
    console.warn("scope block could not be recorded");
  }
}
