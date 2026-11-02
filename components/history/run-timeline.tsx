"use client";
import { useState } from "react";
import { ArrowLeft, Download, GitBranch, RotateCcw, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import type { ChainState, RunDetail } from "@/lib/receipts/history-view";
import { formatDuration, formatTime } from "./format";
import { SaveReplayButton } from "./replay-section";
import { RewindDialog } from "./rewind-dialog";
import { RunBadge } from "./run-list";
import { StepRow } from "./step-row";
import { useRemote } from "./use-remote";

function ChainBadge({ chain, running }: { chain: ChainState; running: boolean }) {
  if (chain.state === "verified") {
    return <span className="inline-flex items-center gap-1 text-xs text-success"><ShieldCheck aria-hidden className="size-4" strokeWidth={1.5} />Chain verified</span>;
  }
  if (chain.state === "unsealed") {
    return <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><ShieldQuestion aria-hidden className="size-4" strokeWidth={1.5} />{running ? "Run in progress, not sealed yet" : "Not sealed"}</span>;
  }
  return (
    <span role="alert" className="inline-flex items-center gap-1 text-xs text-danger">
      <ShieldAlert aria-hidden className="size-4" strokeWidth={1.5} />Chain check failed: <span className="font-mono">{chain.reason}</span>{chain.step !== null ? ` at step ${chain.step}` : ""}
    </span>
  );
}

export function RunTimeline({ runId, timeZone, csrfToken, onBack, backLabel = "All runs", onOpenRun }: {
  runId: string; timeZone: string; csrfToken: string; onBack?: () => void; backLabel?: string; onOpenRun?: (runId: string) => void;
}) {
  const { data, error, loading, reload } = useRemote<RunDetail>(`/api/runs/${runId}`, (value) => (value.run.label === "Running" ? 3000 : null));
  const [rewindStep, setRewindStep] = useState<number | null>(null);

  const back = onBack ? (
    <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
      <ArrowLeft aria-hidden className="size-4" strokeWidth={1.5} />{backLabel}
    </button>
  ) : null;
  if (loading && !data) return <div className="p-4">{back}<p role="status" className="mt-4 text-sm text-muted-foreground">Loading run…</p></div>;
  if (!data) {
    return (
      <div className="flex flex-col items-start gap-3 p-4">
        {back}
        <p role="alert" className="text-sm text-danger">{error === "not_found" ? "This run is no longer available." : "This run could not be loaded."}</p>
        {error !== "not_found" ? <button type="button" onClick={reload} className="text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">Try again</button> : null}
      </div>
    );
  }

  const { run, steps, chain, branches } = data;
  const running = run.label === "Running";
  // A failed run can still be branched. An unsealed or tampered run cannot.
  const canRewind = chain.state === "verified" && !running;
  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-3 border-b border-border p-4">
        {back}
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 text-lg font-semibold tracking-tight [text-wrap:balance] break-words">{run.task || "Untitled task"}</h3>
          <RunBadge run={run} />
        </div>
        <p className="text-xs text-text-subtle tabular-nums">
          {formatTime(run.startedAt, timeZone)} · {run.stepCount} {run.stepCount === 1 ? "step" : "steps"} · <span className="font-mono">{formatDuration(run.durationMs)}</span>
        </p>
        {run.branch ? (
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <GitBranch aria-hidden className="size-3.5" strokeWidth={1.5} />
            Branch of run <span className="font-mono">{run.branch.runId.slice(0, 8)}</span> from step {run.branch.step}
            {onOpenRun ? <button type="button" onClick={() => onOpenRun(run.branch!.runId)}
              className="ml-1 underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">Open original</button> : null}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ChainBadge chain={chain} running={running} />
          <div className="flex flex-wrap items-center gap-2">
            <a href={`/api/runs/${runId}/export`} download className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}>
              <Download aria-hidden className="size-4" strokeWidth={1.5} />Export
            </a>
            <Button type="button" variant="secondary" size="sm" disabled={!canRewind} onClick={() => setRewindStep(0)}
              title={canRewind ? undefined : "Only a sealed, chain-verified run can be branched."}>
              <RotateCcw aria-hidden className="size-4" strokeWidth={1.5} />Rewind and branch
            </Button>
          </div>
        </div>
        {run.verified && chain.state === "verified" ? <SaveReplayButton key={runId} runId={runId} csrfToken={csrfToken} /> : null}
        {branches.length ? (
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium">Branches</p>
            <ul className="flex flex-wrap gap-2">
              {branches.map((branch) => (
                <li key={branch.runId}>
                  <button type="button" onClick={() => onOpenRun?.(branch.runId)}
                    className="rounded-md border border-border bg-surface px-2 py-1 text-xs transition-colors duration-150 hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-ring">
                    <span className="font-mono">{branch.runId.slice(0, 8)}</span> · {branch.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {error ? <p role="alert" className="text-xs text-danger">The latest refresh failed. Showing the last loaded steps.</p> : null}
      </div>
      {steps.length ? (
        <ol aria-label="Steps" className="m-0 list-none p-0">
          {steps.map((step) => <StepRow key={step.idx} runId={runId} step={step} canRewind={canRewind} onRewind={setRewindStep} />)}
        </ol>
      ) : (
        <p className="p-6 text-sm text-muted-foreground">{running ? "No steps yet." : "This run took no recorded steps."}</p>
      )}
      <p className="p-4 text-xs text-text-subtle">Chain verified means the stored receipts are intact and signed. It does not undo or prove anything outside the desktop, such as a sent email.</p>
      {rewindStep !== null ? (
        <RewindDialog runId={runId} steps={steps} baselineCheckpoint={data.baselineCheckpoint} initialStep={rewindStep}
          csrfToken={csrfToken} onClose={() => setRewindStep(null)}
          onCreated={() => { setRewindStep(null); reload(); }} />
      ) : null}
    </div>
  );
}
