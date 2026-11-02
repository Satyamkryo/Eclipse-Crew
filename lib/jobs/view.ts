import { z } from "zod";
import type { RunTone } from "../receipts/history-view";

// TASK-042. Pure helpers shared by the Jobs routes and their client components. Nothing here reads the database or any
// secret: every string that came from the owner, a page or the model is untrusted display text.

export const JOB_TRIGGERS = ["chat", "run_now", "schedule", "replay", "branch", "heal"] as const;
export type JobTrigger = (typeof JOB_TRIGGERS)[number];

export const JOB_OUTCOMES = ["running", "verified", "finished", "needs_you", "paused", "asked_you", "canceled", "failed", "not_sealed"] as const;
export type JobOutcome = (typeof JOB_OUTCOMES)[number];

export const JOB_OUTCOME_FILTERS = ["all", "running", "verified", "finished", "needs_you", "failed", "canceled"] as const;
export type JobOutcomeFilter = (typeof JOB_OUTCOME_FILTERS)[number];

export const JOB_RANGES = ["24h", "7d", "30d", "all"] as const;
export type JobRange = (typeof JOB_RANGES)[number];

export interface JobOutcomeView { outcome: JobOutcome; label: string; tone: RunTone }

export interface JobRow {
  runId: string;
  agentId: string;
  agentName: string;
  // TASK-051. Read from the agent row; the signed run header is never rewritten.
  astraMode: boolean;
  routineId: string | null;
  label: string;
  trigger: JobTrigger;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  stepCount: number;
  costMicroUsd: number;
  outcome: JobOutcome;
  outcomeLabel: string;
  tone: RunTone;
}

export interface JobAttempt {
  runId: string;
  startedAt: string;
  endedAt: string | null;
  outcome: JobOutcome;
  outcomeLabel: string;
  tone: RunTone;
}

export interface JobStepError { idx: number; result: string; code: string | null }

export type RoutineCatchUp = "skip" | "run_once" | "run_all";

export interface UpcomingRoutine {
  routineId: string;
  label: string;
  agentId: string;
  agentName: string;
  astraMode: boolean;
  startAt: string;
  timezone: string;
  schedule: string;
  budgetCents: number;
  catchUp: RoutineCatchUp;
}

export interface PausedRoutine {
  routineId: string;
  label: string;
  agentId: string;
  agentName: string;
  astraMode: boolean;
  nextRunAt: string;
  timezone: string;
  schedule: string;
  budgetCents: number;
  catchUp: RoutineCatchUp;
}

export interface UpcomingView {
  timezone: string;
  days: { date: string; label: string; runs: UpcomingRoutine[] }[];
  paused: PausedRoutine[];
  truncated: boolean;
}

export interface JobDetailView {
  summary: JobRow;
  attempts: JobAttempt[];
  input: string;
  output: string;
  files: string[];
  errors: JobStepError[];
  endNote: string | null;
}

const RUNNING_WINDOW_MS = 15 * 60_000;
const OUTCOME_BY_STATUS: Record<string, JobOutcomeView> = {
  finished: { outcome: "finished", label: "Finished", tone: "success" },
  asked_owner: { outcome: "asked_you", label: "Asked you", tone: "neutral" },
  needs_owner: { outcome: "needs_you", label: "Needs you", tone: "warning" },
  budget_paused: { outcome: "needs_you", label: "Needs you", tone: "warning" },
  security_stop: { outcome: "needs_you", label: "Needs you", tone: "danger" },
  scope_blocked: { outcome: "needs_you", label: "Blocked: outside task", tone: "warning" },
  paused_by_owner: { outcome: "paused", label: "Paused", tone: "warning" },
  aborted: { outcome: "canceled", label: "Canceled", tone: "neutral" },
};
const VERIFIED: JobOutcomeView = { outcome: "verified", label: "Verified", tone: "success" };
const RUNNING: JobOutcomeView = { outcome: "running", label: "Running", tone: "neutral" };
const WAITING_FOR_APPROVAL: JobOutcomeView = { outcome: "running", label: "Waiting for approval", tone: "neutral" };
const NOT_SEALED: JobOutcomeView = { outcome: "not_sealed", label: "Not sealed", tone: "warning" };
const FAILED: JobOutcomeView = { outcome: "failed", label: "Failed", tone: "danger" };

// One place decides what a run is called. "Verified" needs a sealed, finished run whose every recorded step passed or
// executed; a finished run that skipped a check is honest about it. Unsealed runs are only "Running" for 15 minutes.
export function outcomeOf(input: {
  status: string; sealed: boolean; startedAt: Date; endedAt: Date | null; stepResults: readonly string[]; now?: Date;
  waitingForApproval?: boolean;
}): JobOutcomeView {
  const now = input.now ?? new Date();
  if (!input.sealed) {
    // An approval wait extends the run's deadline, so a live request can outlast the generic unsealed window.
    if (input.waitingForApproval) return WAITING_FOR_APPROVAL;
    return now.getTime() - input.startedAt.getTime() < RUNNING_WINDOW_MS ? RUNNING : NOT_SEALED;
  }
  const status = OUTCOME_BY_STATUS[input.status] ?? FAILED;
  if (input.status !== "finished") return status;
  const checked = input.stepResults.length > 0 && input.stepResults.every((result) => result === "pass" || result === "executed");
  return checked ? VERIFIED : status;
}

export const jobListQuerySchema = z.object({
  agent: z.string().uuid().optional(),
  outcome: z.enum(JOB_OUTCOME_FILTERS).default("all"),
  range: z.enum(JOB_RANGES).default("7d"),
  q: z.string().trim().min(1).max(100).optional(),
  cursor: z.string().max(400).optional(),
}).strict();
export type JobListQuery = z.infer<typeof jobListQuerySchema>;

export const jobUpcomingQuerySchema = z.object({
  days: z.enum(["1", "7", "30"]).default("7"),
  agent: z.string().uuid().optional(),
}).strict();

export function rangeStart(range: JobRange, now = new Date()): Date | null {
  if (range === "all") return null;
  const hours = range === "24h" ? 24 : range === "7d" ? 24 * 7 : 24 * 30;
  return new Date(now.getTime() - hours * 60 * 60_000);
}

const TRIGGER_LABEL: Record<JobTrigger, string> = {
  chat: "Chat",
  run_now: "Run now",
  schedule: "Scheduled",
  replay: "Replay",
  branch: "Branch",
  heal: "Self-heal",
};

export function triggerLabel(trigger: JobTrigger): string {
  return TRIGGER_LABEL[trigger];
}

// Older runs have no metadata row. A replay names itself in the signed task ("Replay: <script name>"); everything else
// that exists today was started from chat.
export function triggerOf(stored: string | null | undefined, task: string): JobTrigger {
  if (stored && (JOB_TRIGGERS as readonly string[]).includes(stored)) return stored as JobTrigger;
  return task.startsWith("Replay: ") ? "replay" : "chat";
}

export function shortRunId(runId: string): string {
  return `run_${runId.slice(0, 8)}`;
}

export const END_NOTE: Record<string, string> = {
  needs_owner: "The run stopped and needs you to take the next step.",
  paused_by_owner: "The run stopped because the desktop was taken over.",
  invalid_output: "The run stopped because the model did not return a usable step twice in a row.",
  step_limit: "The run stopped after its step limit.",
  token_limit: "The run stopped because it reached its token limit.",
  time_limit: "The run stopped because it reached its time limit.",
  repeat_limit: "The run stopped because it repeated the same step.",
  budget_paused: "The run stopped because the agent reached a budget limit.",
  security_stop: "The run stopped because a canary secret was found in data it was about to send.",
  scope_blocked: "The run stopped because it tried twice to type an address or email outside the task's scope.",
  price_required: "The run stopped before spending because its model has no price configured.",
  cost_error: "The run stopped because its cost could not be recorded or checked.",
  provider_error: "The run stopped because the model provider returned an error.",
  desktop_error: "The run stopped because the desktop did not accept a command.",
  aborted: "The run was cancelled. Steps already sent to the desktop are not taken back.",
  receipt_error: "The run stopped because it could not record proof of a step.",
};

const headerSchema = z.object({
  agent_name: z.string().max(200).optional(),
  task: z.string().max(2000).optional(),
}).passthrough();

export function readRunHeader(headerText: string): { agentName: string; task: string } {
  try {
    const parsed = headerSchema.safeParse(JSON.parse(headerText));
    if (!parsed.success) return { agentName: "", task: "" };
    return { agentName: parsed.data.agent_name ?? "", task: parsed.data.task ?? "" };
  } catch {
    return { agentName: "", task: "" };
  }
}

const cursorSchema = z.object({ s: z.string().datetime(), id: z.string().uuid() }).strict();
export interface JobCursor { startedAt: Date; id: string }

export function encodeCursor(row: { startedAt: Date | string; id: string }): string {
  const startedAt = typeof row.startedAt === "string" ? row.startedAt : row.startedAt.toISOString();
  const text = JSON.stringify({ s: startedAt, id: row.id });
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function decodeCursor(value: string): JobCursor | null {
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const parsed = cursorSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    if (!parsed.success) return null;
    const startedAt = new Date(parsed.data.s);
    if (Number.isNaN(startedAt.getTime())) return null;
    return { startedAt, id: parsed.data.id };
  } catch {
    return null;
  }
}

// LIKE treats % and _ as wildcards and backslash as its escape character. Search is a plain substring, so escape all three.
export function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
