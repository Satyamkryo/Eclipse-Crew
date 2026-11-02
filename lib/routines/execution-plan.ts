import { createHash } from "node:crypto";

import type { RunOutcome } from "../agent/step-loop";
import { nextRoutineRun, previousRoutineRun } from "./schedule";
import type { RoutineScheduleSpec } from "./schema";

const CURRENT_GRACE_MS = 60_000;

export type RoutineCatchUp = "skip" | "run_once" | "run_all";

export interface RoutineOccurrencePlan {
  scheduledAt: Date[];
  nextRunAt: Date;
  active: boolean;
  more: boolean;
}

export function routineExecutionId(routineId: string, scheduledAt: Date): string {
  const hex = createHash("sha256").update(`${routineId}\0${scheduledAt.toISOString()}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function selectRoutineOccurrences(input: {
  spec: RoutineScheduleSpec;
  timezone: string;
  nextRunAt: Date;
  now: Date;
  catchUp: RoutineCatchUp;
  limit?: number;
}): RoutineOccurrencePlan {
  const { spec, timezone, nextRunAt, now, catchUp } = input;
  if (nextRunAt.getTime() > now.getTime()) {
    return { scheduledAt: [], nextRunAt, active: true, more: false };
  }

  if (spec.kind === "once") {
    const runAt = new Date(spec.runAt);
    return {
      scheduledAt: catchUp === "skip" ? [] : [runAt],
      nextRunAt,
      active: false,
      more: false,
    };
  }

  if (catchUp !== "run_all") {
    const current = nextRoutineRun(spec, timezone, new Date(now.getTime() - CURRENT_GRACE_MS - 1));
    const isCurrent = current.getTime() <= now.getTime();
    const latest = isCurrent ? current : previousRoutineRun(spec, timezone, new Date(now.getTime() + 1));
    const scheduledAt = catchUp === "skip"
      ? (isCurrent ? [current] : [])
      : latest ? [latest] : [];
    return {
      scheduledAt,
      nextRunAt: nextRoutineRun(spec, timezone, now),
      active: true,
      more: false,
    };
  }

  const limit = Math.max(1, input.limit ?? 100);
  const scheduledAt: Date[] = [];
  let cursor = nextRunAt;
  while (cursor.getTime() <= now.getTime() && scheduledAt.length < limit) {
    scheduledAt.push(cursor);
    cursor = nextRoutineRun(spec, timezone, cursor);
  }
  const more = cursor.getTime() <= now.getTime();
  return {
    scheduledAt,
    nextRunAt: more ? cursor : nextRoutineRun(spec, timezone, now),
    active: true,
    more,
  };
}

export interface ScheduledRoutineJob {
  ownerId: string;
  routineId: string;
  agentId: string;
  executionId: string;
  trigger: "schedule";
  scheduledAt: string;
}

export function scheduledRoutineJobs(input: {
  ownerId: string;
  routineId: string;
  agentId: string;
  spec: RoutineScheduleSpec;
  timezone: string;
  nextRunAt: Date;
  now: Date;
  catchUp: RoutineCatchUp;
  limit?: number;
}): { jobs: ScheduledRoutineJob[]; nextRunAt: Date; active: boolean; more: boolean } {
  const plan = selectRoutineOccurrences(input);
  return {
    jobs: plan.scheduledAt.map((scheduledAt) => ({
      ownerId: input.ownerId,
      routineId: input.routineId,
      agentId: input.agentId,
      executionId: routineExecutionId(input.routineId, scheduledAt),
      trigger: "schedule",
      scheduledAt: scheduledAt.toISOString(),
    })),
    nextRunAt: plan.nextRunAt,
    active: plan.active,
    more: plan.more,
  };
}

export function routineTaskText(goal: string, steps: readonly string[]): string {
  const cleanGoal = goal.trim();
  if (steps.length === 0) return `${cleanGoal}\n\nUse the approved skill for this routine.`;
  return `${cleanGoal}\n\nSteps:\n${steps.map((step, index) => `${index + 1}. ${step.trim()}`).join("\n")}`;
}

const RETRYABLE = new Set<RunOutcome>([
  "busy", "provider_error", "desktop_error", "time_limit", "receipt_error", "cost_error",
]);

export function routineOutcomeDisposition(outcome: RunOutcome): "retry" | "complete" {
  return RETRYABLE.has(outcome) ? "retry" : "complete";
}
