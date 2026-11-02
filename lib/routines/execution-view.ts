import type { RunDetail } from "../receipts/history-view";

export type QueueExecutionState = "created" | "retry" | "active" | "completed" | "cancelled" | "failed";
export type RoutineExecutionState = "queued" | "retrying" | "starting" | "running" | "completed" | "failed";

export interface RoutineExecutionView {
  executionId: string;
  state: RoutineExecutionState;
  retryCount: number;
  runId: string | null;
  detail: RunDetail | null;
}

export function executionState(state: QueueExecutionState | null, hasRun: boolean): RoutineExecutionState | null {
  if (state === "created") return "queued";
  if (state === "retry") return "retrying";
  if (state === "active") return hasRun ? "running" : "starting";
  if (state === "completed") return hasRun ? "completed" : "failed";
  if (state === "failed" || state === "cancelled") return "failed";
  return hasRun ? "completed" : null;
}

function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function executionStatusText(
  view: RoutineExecutionView,
  now = new Date(),
): { label: string; detail: string } {
  if (view.state === "queued") return { label: "Queued", detail: "Waiting for the agent." };
  if (view.state === "retrying") return { label: "Retrying", detail: `Attempt ${view.retryCount + 1} starts automatically.` };
  if (view.state === "starting") return { label: "Starting", detail: "The run is preparing the agent." };
  if (view.state === "failed") return {
    label: "Couldn't start",
    detail: "The run could not start. Check the agent and model settings, then try again.",
  };
  if (!view.detail) return { label: "Failed", detail: "The run ended without a signed result." };

  const run = view.detail.run;
  const cost = view.detail.steps.reduce((sum, step) => sum + (step.costMicroUsd ?? 0), 0);
  const elapsed = (run.endedAt ? new Date(run.endedAt).getTime() : now.getTime()) - new Date(run.startedAt).getTime();
  if (view.state === "running") {
    const last = view.detail.steps.at(-1);
    return {
      label: `Running · step ${Math.max(1, view.detail.steps.length)}`,
      detail: `${last ? `${last.action}${last.target ? `: ${last.target}` : ""}` : "Waiting for the first receipt"} · ${duration(elapsed)} · $${(cost / 1_000_000).toFixed(4)}`,
    };
  }
  return {
    label: run.label,
    detail: `${view.detail.steps.length} ${view.detail.steps.length === 1 ? "step" : "steps"} · ${duration(elapsed)} · $${(cost / 1_000_000).toFixed(4)}`,
  };
}

export function executionView(
  executionId: string,
  job: { state: QueueExecutionState; retryCount: number } | null,
  detail: RunDetail | null,
): RoutineExecutionView | null {
  const state = executionState(job?.state ?? null, detail !== null);
  return state === null ? null : {
    executionId,
    state,
    retryCount: job?.retryCount ?? 0,
    runId: detail?.run.runId ?? null,
    detail,
  };
}
