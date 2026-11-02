"use client";
import { Check, ChevronRight, CircleAlert, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RunSummary } from "@/lib/receipts/history-view";
import { TONE_CLASS, formatDuration, formatTime } from "./format";
import { useRemote } from "./use-remote";

export function RunBadge({ run }: { run: Pick<RunSummary, "label" | "tone" | "verified"> }) {
  const Icon = run.verified || run.tone === "success" ? Check : run.tone === "danger" ? X : run.label === "Running" ? Loader2 : CircleAlert;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-xs", TONE_CLASS[run.tone])}>
      <Icon aria-hidden className={cn("size-3", run.label === "Running" && "motion-safe:animate-spin")} strokeWidth={1.5} />
      {run.label}
    </span>
  );
}

export function RunList({ agentId, timeZone, onOpen }: { agentId: string; timeZone: string; onOpen: (runId: string) => void }) {
  const { data, error, loading, reload } = useRemote<{ runs: RunSummary[] }>(
    `/api/agents/${agentId}/runs`, (value) => (value.runs.some((run) => run.label === "Running") ? 5000 : null));

  if (loading && !data) return <p role="status" className="p-6 text-sm text-muted-foreground">Loading history…</p>;
  if (error && !data) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 p-6">
        <p className="text-sm text-danger">History could not be loaded.</p>
        <button type="button" onClick={reload} className="text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">Try again</button>
      </div>
    );
  }
  if (!data?.runs.length) {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-1 px-6 py-12 text-center">
        <p className="text-sm font-medium">No runs yet</p>
        <p className="text-sm text-muted-foreground">Send this agent a task in chat. Each run appears here with its steps and proof.</p>
      </div>
    );
  }
  return (
    <ul aria-label="Runs" className="divide-y divide-border">
      {data.runs.map((run) => (
        <li key={run.runId}>
          <button type="button" onClick={() => onOpen(run.runId)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{run.task || "Untitled task"}</span>
              <span className="mt-0.5 block text-xs text-text-subtle tabular-nums">
                {formatTime(run.startedAt, timeZone)} · {run.stepCount} {run.stepCount === 1 ? "step" : "steps"} · <span className="font-mono">{formatDuration(run.durationMs)}</span>
              </span>
              {run.branch ? (
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Branch of <span className="font-mono">{run.branch.runId.slice(0, 8)}</span> from step {run.branch.step}
                </span>
              ) : null}
            </span>
            <RunBadge run={run} />
            <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
          </button>
        </li>
      ))}
    </ul>
  );
}
