import "server-only";

import type { getDatabase } from "../../db/client";
import type { RunCard } from "../agent/step-loop";
import { countUses, createApproval, expireApproval, findGrant, markApprovalStale, recordUse } from "./store";
import { APPROVAL_WAIT_MS, type ApprovalGate, type ApprovalGateResult, type ApprovalRequest } from "./types";
import { waitForDecision } from "./waiters";

type Database = Awaited<ReturnType<typeof getDatabase>>;
const USE_WINDOW_MS = 24 * 60 * 60_000;

export interface ApprovalGatePorts {
  database: Database;
  ownerId: string;
  postCard: (card: RunCard) => Promise<void>;
  setAttention?: () => Promise<void>;
  clearAttention?: () => Promise<void>;
  waitMs?: number;
  now?: () => Date;
}

// TASK-050. A live grant with capacity allows without asking; otherwise the owner is asked in chat and the run waits.
// A failed card, a timeout or a lost desktop decision all fail closed: nothing executes.
export function createApprovalGate(ports: ApprovalGatePorts): ApprovalGate {
  const now = ports.now ?? (() => new Date());
  const waitMs = ports.waitMs ?? APPROVAL_WAIT_MS;

  return {
    async request(input: ApprovalRequest): Promise<ApprovalGateResult> {
      // TASK-051. Only the prompt is removed. The decision is still recorded so History can show what ran unattended.
      if (input.astra) {
        await createApproval(ports.database, {
          ownerId: ports.ownerId, agentId: input.agentId, runId: input.runId, actionClass: input.actionClass,
          site: input.site, controlName: input.controlName, state: "auto_allowed",
        });
        return { decision: "allow", waitedMs: 0, reason: "astra" };
      }

      if (input.site) {
        const grant = await findGrant(ports.database, ports.ownerId, input.agentId, input.site, input.actionClass);
        if (grant) {
          const used = await countUses(ports.database, ports.ownerId, grant.id, new Date(now().getTime() - USE_WINDOW_MS));
          if (used < grant.maxPerDay) {
            await recordUse(ports.database, ports.ownerId, grant.id, input.runId);
            return { decision: "allow", waitedMs: 0, reason: "grant" };
          }
        }
      }

      const approvalId = await createApproval(ports.database, {
        ownerId: ports.ownerId,
        agentId: input.agentId,
        runId: input.runId,
        actionClass: input.actionClass,
        site: input.site,
        controlName: input.controlName,
      });
      try {
        await ports.postCard({
          type: "approval", approvalId, actionClass: input.actionClass, site: input.site ?? "", controlName: input.controlName,
        });
      } catch {
        await expireApproval(ports.database, ports.ownerId, approvalId).catch(() => undefined);
        return { decision: "deny", waitedMs: 0, reason: "timeout" };
      }
      await ports.setAttention?.().catch(() => undefined);

      const started = now().getTime();
      const answer = await waitForDecision(approvalId, input.signal, waitMs);
      const waitedMs = Math.max(0, now().getTime() - started);
      await ports.clearAttention?.().catch(() => undefined);

      if (answer === "allow_once" || answer === "always_allow") {
        return {
          decision: "allow", waitedMs, approvalId,
          reason: answer === "always_allow" ? "always_allowed" : "allowed_once",
        };
      }
      // Timeout, owner cancel or a lost process: a pending request becomes expired, never allowed.
      await expireApproval(ports.database, ports.ownerId, approvalId).catch(() => undefined);
      return { decision: "deny", waitedMs, approvalId, reason: answer === "aborted" ? "aborted" : "timeout" };
    },
    async markStale(approvalId: string) {
      await markApprovalStale(ports.database, ports.ownerId, approvalId);
    },
  };
}
