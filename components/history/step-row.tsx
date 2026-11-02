"use client";
import { useId, useState } from "react";
import { Check, ChevronDown, ChevronRight, CircleAlert, ImageOff, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { StepView } from "@/lib/receipts/history-view";
import { TONE_CLASS, formatCost, shortHash } from "./format";

const RESULT_LABEL: Record<string, string> = {
  pass: "Passed", fail: "Failed", unknown: "Not verified", blocked: "Blocked", executed: "Done", failed: "Failed",
};

function Evidence({ runId, hash, label, step, box }: { runId: string; hash: string | null; label: string; step: StepView; box?: StepView["samBox"] }) {
  const [broken, setBroken] = useState(false);
  if (!hash || broken) {
    return (
      <div className="flex aspect-[4/3] w-full items-center justify-center gap-2 rounded-md border border-border bg-surface text-xs text-muted-foreground">
        <ImageOff aria-hidden className="size-4" strokeWidth={1.5} />{label}: screenshot not stored
      </div>
    );
  }
  return (
    <figure className="m-0">
      <figcaption className="mb-1 text-xs text-muted-foreground">{label}</figcaption>
      <div className="relative overflow-hidden rounded-md border border-border bg-black">
        {/* eslint-disable-next-line @next/next/no-img-element -- owner-only evidence route; the bytes are the hashed PNG */}
        <img src={`/api/runs/${runId}/evidence/${hash}`} alt={`${label} screenshot of step ${step.idx}`} loading="lazy" decoding="async"
          onError={() => setBroken(true)} className="block h-auto w-full" width={step.imageWidth ?? undefined} height={step.imageHeight ?? undefined} />
        {box ? (
          <span aria-hidden className="pointer-events-none absolute border-2 border-corona"
            style={{ left: `${(box.x1 / box.width) * 100}%`, top: `${(box.y1 / box.height) * 100}%`,
              width: `${((box.x2 - box.x1) / box.width) * 100}%`, height: `${((box.y2 - box.y1) / box.height) * 100}%` }} />
        ) : null}
      </div>
    </figure>
  );
}

function Thumb({ runId, hash, label }: { runId: string; hash: string | null; label: string }) {
  const [broken, setBroken] = useState(false);
  if (!hash || broken) return <span aria-hidden className="block h-9 w-14 rounded-sm border border-dashed border-border" />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- owner-only evidence route
    <img src={`/api/runs/${runId}/evidence/${hash}`} alt={label} loading="lazy" decoding="async" onError={() => setBroken(true)}
      className="block h-9 w-14 rounded-sm border border-border object-cover object-top" />
  );
}

export function StepRow({ runId, step, canRewind, onRewind }: {
  runId: string; step: StepView; canRewind?: boolean; onRewind?: (step: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const ok = step.tone === "success";
  const Icon = ok ? Check : step.tone === "danger" ? X : CircleAlert;
  const label = RESULT_LABEL[step.result] ?? "Not verified";

  return (
    <li className="border-b border-border">
      <button type="button" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen((value) => !value)}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-left transition-colors duration-150 hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring">
        {open ? <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
          : <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />}
        <span className="w-6 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">{step.idx}</span>
        <span className="min-w-0 flex-1 basis-40">
          <span className="block truncate text-sm">{step.action}{step.target ? <span className="text-muted-foreground"> · {step.target}</span> : null}</span>
          <span className="block truncate text-xs text-text-subtle">{step.method}</span>
        </span>
        <span className="flex shrink-0 gap-1">
          <Thumb runId={runId} hash={step.beforeImage} label={`Before, step ${step.idx}`} />
          <Thumb runId={runId} hash={step.afterImage} label={`After, step ${step.idx}`} />
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{step.confidence}</span>
        <span className="shrink-0 font-mono text-xs tabular-nums">{formatCost(step.costMicroUsd)}</span>
        <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-xs", TONE_CLASS[step.tone])}>
          <Icon aria-hidden className="size-3" strokeWidth={1.5} />{label}
        </span>
      </button>
      {open ? (
        <div id={detailId} className="flex flex-col gap-4 px-4 pb-4">
          {step.screens === "none" ? (
            <p className="text-xs text-muted-foreground">This step did not use the screen, so there are no screenshots.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <Evidence runId={runId} hash={step.beforeImage} label="Before" step={step} />
              <Evidence runId={runId} hash={step.afterImage} label="After" step={step} box={step.samBox} />
            </div>
          )}
          {step.samBox ? <p className="text-xs text-muted-foreground">Gold outline: the element SAM found. It is a display annotation; the signed receipt covers the image hashes.</p> : null}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Expected</dt><dd className="min-w-0 break-words">{step.postcondition || "—"}</dd>
            <dt className="text-muted-foreground">Result</dt><dd>{label}{step.code ? <span className="font-mono text-muted-foreground"> · {step.code}</span> : null}</dd>
            <dt className="text-muted-foreground">Model</dt><dd className="font-mono">{step.model || "—"}</dd>
            <dt className="text-muted-foreground">Checkpoint</dt>
            <dd>{step.checkpoint === "saved" ? "Saved" : (
              <span>{step.checkpoint === "partial" ? "Incomplete" : "Not saved"}{step.checkpointReason ? <span className="font-mono text-muted-foreground"> · {step.checkpointReason}</span> : null}. Can&apos;t rewind to this step.</span>
            )}</dd>
            <dt className="text-muted-foreground">Receipt</dt><dd className="font-mono" title={step.receiptHash}>{shortHash(step.receiptHash)}</dd>
            <dt className="text-muted-foreground">Previous</dt><dd className="font-mono" title={step.prevHash}>{shortHash(step.prevHash)}</dd>
          </dl>
          {canRewind && step.checkpoint === "saved" && onRewind ? (
            <div className="flex justify-end">
              <Button type="button" variant="secondary" size="sm" onClick={() => onRewind(step.idx)}>
                <RotateCcw aria-hidden className="size-4" strokeWidth={1.5} />Rewind to here
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
