"use client";

import { Check, ChevronRight, CircleAlert, Loader2, X } from "lucide-react";
import { formatCost, formatDuration, formatTime, TONE_CLASS } from "@/components/history/format";
import { AstraBadge } from "@/components/ui/astra-badge";
import { cn } from "@/lib/utils";
import { shortRunId, triggerLabel, type JobRow } from "@/lib/jobs/view";

export function JobOutcomeBadge({ row }: { row: Pick<JobRow, "outcomeLabel" | "tone"> }) {
  const Icon = row.tone === "success" ? Check
    : row.tone === "danger" ? X
      : row.outcomeLabel === "Running" ? Loader2 : CircleAlert;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs", TONE_CLASS[row.tone])}>
      <Icon aria-hidden className={cn("size-3", row.outcomeLabel === "Running" && "motion-safe:animate-spin")} strokeWidth={1.5} />
      {row.outcomeLabel}
    </span>
  );
}

function Cost({ micro }: { micro: number }) {
  return <span className="font-mono tabular-nums">{formatCost(micro)}</span>;
}

export function JobsTable({ jobs, selectedRunId, timeZone, onSelect }: {
  jobs: JobRow[]; selectedRunId: string | null; timeZone: string; onSelect: (runId: string) => void;
}) {
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full table-fixed border-collapse text-sm">
          <caption className="sr-only">Runs across the crew, newest first</caption>
          <colgroup>
            <col className="w-[11%]" />
            <col className="w-[14%]" />
            <col className="w-[19%]" />
            <col className="w-[11%]" />
            <col className="w-[14%]" />
            <col className="w-[9%]" />
            <col className="w-[10%]" />
            <col className="w-[12%]" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th scope="col" className="whitespace-nowrap px-2 py-2 font-medium">Run ID</th>
              <th scope="col" className="whitespace-nowrap px-2 py-2 font-medium">Agent</th>
              <th scope="col" className="whitespace-nowrap px-2 py-2 font-medium">Routine</th>
              <th scope="col" className="whitespace-nowrap px-2 py-2 font-medium">Trigger</th>
              <th scope="col" className="whitespace-nowrap px-2 py-2 font-medium">Started</th>
              <th scope="col" className="whitespace-nowrap px-2 py-2 font-medium">Duration</th>
              <th scope="col" className="whitespace-nowrap px-2 py-2 font-medium">Cost</th>
              <th scope="col" className="whitespace-nowrap px-2 py-2 font-medium">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.runId} onClick={() => onSelect(job.runId)}
                className={cn("h-10 cursor-pointer border-b border-border transition-colors duration-150 last:border-b-0 hover:bg-accent",
                  selectedRunId === job.runId && "bg-accent")}>
                <td className="px-2 py-1.5">
                  <button type="button" onClick={(event) => { event.stopPropagation(); onSelect(job.runId); }}
                    className="rounded-sm font-mono text-xs underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    aria-label={`Select ${shortRunId(job.runId)}`}>
                    {shortRunId(job.runId)}
                  </button>
                </td>
                <td className="px-2 py-1.5">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate" title={job.agentName}>{job.agentName}</span>
                    {job.astraMode && <AstraBadge />}
                  </span>
                </td>
                <td className="truncate px-2 py-1.5" title={job.label}>{job.label}</td>
                <td className="truncate px-2 py-1.5 text-muted-foreground">{triggerLabel(job.trigger)}</td>
                <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-muted-foreground">{formatTime(job.startedAt, timeZone)}</td>
                <td className="px-2 py-1.5 font-mono tabular-nums">{formatDuration(job.durationMs)}</td>
                <td className="px-2 py-1.5"><Cost micro={job.costMicroUsd} /></td>
                <td className="px-2 py-1.5"><JobOutcomeBadge row={job} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul aria-label="Runs across the crew, newest first" className="divide-y divide-border md:hidden">
        {jobs.map((job) => (
          <li key={job.runId}>
            <button type="button" onClick={() => onSelect(job.runId)}
              className={cn("flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
                selectedRunId === job.runId && "bg-accent")}>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{job.label}</span>
                <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-text-subtle">
                  <span className="truncate">{job.agentName}</span>
                  {job.astraMode && <AstraBadge />}
                  <span className="shrink-0">· {triggerLabel(job.trigger)}</span>
                </span>
                <span className="mt-0.5 block text-xs text-text-subtle tabular-nums">
                  {formatTime(job.startedAt, timeZone)} · {job.stepCount} {job.stepCount === 1 ? "step" : "steps"}
                  {job.helperCount > 0 ? ` · ${job.helperCount} ${job.helperCount === 1 ? "helper" : "helpers"}` : ""} · <Cost micro={job.costMicroUsd} />
                </span>
              </span>
              <JobOutcomeBadge row={job} />
              <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
