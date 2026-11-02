import type { ActionClass } from "../agent/risk";

// TASK-050. Shared approval vocabulary. Pure types only: client components import this module.

export const APPROVAL_WAIT_MS = 10 * 60_000;

export const APPROVAL_STATES = ["pending", "allowed_once", "always_allowed", "denied", "expired", "stale", "auto_allowed"] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

export const APPROVAL_DECISIONS = ["allow_once", "always_allow", "deny"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export interface ApprovalView {
  id: string;
  state: ApprovalState;
  actionClass: ActionClass;
  site: string;
  controlName: string;
  decidedAt: string | null;
  canAlwaysAllow: boolean;
}

export interface ApprovalRequest {
  agentId: string;
  runId: string | null;
  actionClass: ActionClass;
  site: string | null;
  controlName: string;
  signal?: AbortSignal;
  // TASK-051. Astra Mode removes only the wait; the request is still recorded.
  astra?: boolean;
}

export type ApprovalGateResult = {
  decision: "allow" | "deny";
  waitedMs: number;
  reason: "grant" | "allowed_once" | "always_allowed" | "denied" | "timeout" | "aborted" | "astra";
  // Set when the answer came from an approval row (not a stored grant).
  approvalId?: string;
};

export interface ApprovalGate {
  request(input: ApprovalRequest): Promise<ApprovalGateResult>;
  // The page changed before execution: the decision is void and the row says so.
  markStale?(approvalId: string): Promise<void>;
}
