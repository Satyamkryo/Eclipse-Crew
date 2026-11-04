"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { RunTimeline } from "@/components/history/run-timeline";
import { formatTime, TONE_CLASS } from "@/components/history/format";
import { useRemote } from "@/components/history/use-remote";
import { cn } from "@/lib/utils";
import { shortRunId, type JobDetailView } from "@/lib/jobs/view";
import { JobSummary } from "./job-summary";

export function JobDetail({ runId, timeZone, csrfToken }: { runId: string; timeZone: string; csrfToken: string }) {
  const { data, error, loading, reload } = useRemote<JobDetailView>(
    `/api/jobs/${runId}`, (value) => (value.summary.outcome === "running" ? 5000 : null));

  const back = (
    <Link href="/mission-control" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
      <ArrowLeft aria-hidden className="size-4" strokeWidth={1.5} />Runs
    </Link>
  );

  if (loading && !data) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
        {back}
        <div aria-busy="true" className="mt-6 flex flex-col gap-4">
          <div className="h-24 animate-pulse rounded-lg bg-accent" />
          <div className="h-48 animate-pulse rounded-lg bg-accent" />
          <p role="status" className="sr-only">Loading run</p>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
        {back}
        <div role="alert" className="mt-6 flex flex-col items-start gap-2 rounded-lg border border-border bg-card p-6">
          <p className="text-sm text-danger">{error === "not_found" ? "This run is no longer available." : "This run could not be loaded."}</p>
          {error !== "not_found" ? <button type="button" onClick={reload} className="text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">Try again</button> : null}
        </div>
      </div>
    );
  }

  const { summary, attempts, input, output, files, errors, endNote } = data;
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-3">
        {back}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight [text-wrap:balance] break-words">{summary.label}</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              <span className="font-mono">{shortRunId(summary.runId)}</span> · {summary.agentName} · {formatTime(summary.startedAt, timeZone)}
            </p>
          </div>
        </div>
      </header>

      <JobSummary summary={summary} timeZone={timeZone} csrfToken={csrfToken} onChanged={reload} heading="Run summary" showOpen={false} />

      {endNote ? <p role="status" className="rounded-lg border border-border bg-card p-4 text-sm">{endNote}</p> : null}

      <section aria-labelledby="run-input" className="rounded-lg border border-border bg-card p-4">
        <h2 id="run-input" className="text-sm font-semibold tracking-tight">Input</h2>
        <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">{input || "No task text recorded."}</p>
      </section>

      <section aria-labelledby="run-output" className="rounded-lg border border-border bg-card p-4">
        <h2 id="run-output" className="text-sm font-semibold tracking-tight">Output</h2>
        <p className="mt-2 whitespace-pre-wrap break-words text-sm">{output || "No final answer was posted."}</p>
        {files.length ? (
          <div className="mt-3">
            <h3 className="text-xs font-medium text-muted-foreground">Delivered files</h3>
            <ul className="mt-1 list-disc pl-5 text-sm">
              {files.map((file) => <li key={file} className="break-all">{file}</li>)}
            </ul>
          </div>
        ) : null}
      </section>

      {errors.length ? (
        <section aria-labelledby="run-errors" className="rounded-lg border border-danger/40 bg-card p-4">
          <h2 id="run-errors" className="text-sm font-semibold tracking-tight">Errors</h2>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {errors.map((item) => (
              <li key={item.idx}>
                Step {item.idx}: <span className="text-danger">{item.result}</span>
                {item.code ? <span className="text-muted-foreground"> · <span className="font-mono text-xs">{item.code}</span></span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {attempts.length ? (
        <section aria-labelledby="run-attempts" className="rounded-lg border border-border bg-card p-4">
          <h2 id="run-attempts" className="text-sm font-semibold tracking-tight">Attempts</h2>
          <ol className="mt-2 flex flex-col divide-y divide-border">
            {attempts.map((attempt) => (
              <li key={attempt.runId} className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
                <Link href={`/jobs/${attempt.runId}`} className="font-mono text-xs underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">
                  {shortRunId(attempt.runId)}
                </Link>
                <span className="text-xs text-muted-foreground tabular-nums">{formatTime(attempt.startedAt, timeZone)}</span>
                <span className={cn("rounded-md px-2 py-0.5 text-xs", TONE_CLASS[attempt.tone])}>{attempt.outcomeLabel}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <section aria-labelledby="run-timeline" className="overflow-hidden rounded-lg border border-border bg-card">
        <h2 id="run-timeline" className="border-b border-border px-4 py-3 text-sm font-semibold tracking-tight">Steps and receipts</h2>
        <RunTimeline runId={runId} timeZone={timeZone} csrfToken={csrfToken} />
      </section>
    </div>
  );
}
