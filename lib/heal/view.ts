import type { ChatCard } from "../chat/schema";
import type { DiffRow } from "../replay/diff";
import type { HealFailureCode } from "./codes";

// TASK-044. Shared proposal types and fixed wording. No server-only import: the chat card and the History review use it.
export type ProposalStatus = "pending" | "approved" | "rejected";

export interface SkillUpdateDetail {
  id: string;
  scriptId: string;
  scriptName: string;
  agentId: string;
  fromVersion: number;
  toVersion: number;
  status: ProposalStatus;
  failedStep: number;
  failureCode: HealFailureCode;
  reason: string;
  changedSteps: number;
  oldStepCount: number;
  newStepCount: number;
  diff: DiffRow[];
  healRunId: string;
  replayRunId: string;
  stale: boolean;
  canDecide: boolean;
  createdAt: string;
  decidedAt: string | null;
}

const REASON: Record<HealFailureCode, string> = {
  target_missing: "The control this step needs is no longer on the page.",
  ambiguous_target: "More than one control matches this step now.",
  target_changed: "The control moved or changed before it could be used.",
  unsupported_focus: "The text field this step needs was not focused.",
  postcondition_failed: "The page did not show the expected result.",
  postcondition_unknown: "The expected result could not be checked.",
};

// Fixed sentence plus the old step label (page text, shown as plain escaped text).
export function healReason(code: HealFailureCode, failedStepText: string): string {
  return `${REASON[code]} ${failedStepText}`;
}

export function skillUpdateCard(input: {
  proposalId: string;
  scriptName: string;
  fromVersion: number;
  toVersion: number;
  failedStep: number;
  changedSteps: number;
  failureCode: HealFailureCode;
}): ChatCard {
  return {
    type: "skill_update",
    proposalId: input.proposalId,
    scriptName: input.scriptName,
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    failedStep: input.failedStep,
    changedSteps: input.changedSteps,
    failureCode: input.failureCode,
  };
}
