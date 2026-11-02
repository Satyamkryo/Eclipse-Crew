"use client";

import { useId, type ReactNode } from "react";
import { formatCost, formatDuration, formatTime } from "@/components/history/format";
import { shortRunId, triggerLabel, type JobRow } from "@/lib/jobs/view";
import { JobActions } from "./job-actions";
import { JobOutcomeBadge } from "./jobs-table";

export function JobSummary({ summary, timeZone, csrfToken, onChanged, heading = "Selected job", showActions = true, showOpen = true }: {
  summary: JobRow; timeZone: string; csrfToken: string; onChanged?: () => void; heading?: string; showActions?: boolean; showOpen?: boolean;
}) {
  const headingId = useId();
  const fields: [string, string | ReactNode][] = [
    ["Run ID", <span key="id" className="font-mono text-xs">{shortRunId(summary.runId)}</span>],
    ["Agent", summary.agentName],
    ["Routine", summary.label],
    ["Trigger", triggerLabel(summary.trigger)],
    ["Started", formatTime(summary.startedAt, timeZone)],
    ["Duration", <span key="duration" className="font-mono tabular-nums">{formatDuration(summary.durationMs)}</span>],
    ["Steps", `${summary.stepCount} ${summary.stepCount === 1 ? "step" : "steps"}`],
    ["Cost", <span key="cost" className="font-mono tabular-nums">{formatCost(summary.costMicroUsd)}</span>],
  ];
  return (
    <section aria-labelledby={headingId} className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <h2 id={headingId} className="text-sm font-semibold tracking-tight">{heading}</h2>
        <JobOutcomeBadge row={summary} />
      </div>
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        {fields.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
      {showActions ? (
        <div className="mt-4">
          <JobActions runId={summary.runId} label={summary.label} outcome={summary.outcome} trigger={summary.trigger}
            routineId={summary.routineId} csrfToken={csrfToken} onChanged={onChanged} showOpen={showOpen} />
        </div>
      ) : null}
    </section>
  );
}
