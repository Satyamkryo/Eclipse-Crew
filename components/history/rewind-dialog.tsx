"use client";
import { useId, useMemo, useState, type FormEvent } from "react";
import { AlertTriangle, Check, GitBranch, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/workspace/modal-dialog";
import type { StepView } from "@/lib/receipts/history-view";
import { cn } from "@/lib/utils";

type Checkpoint = StepView["checkpoint"];

const ERROR_TEXT: Record<string, string> = {
  invalid_input: "Write a correction between 1 and 600 characters.",
  run_not_found: "This run is no longer available.",
  run_not_rewindable: "This run can't be branched because its proof does not verify.",
  step_out_of_range: "That step is not part of this run.",
  checkpoint_missing: "This step has no saved checkpoint, so it can't be restored.",
  checkpoint_incomplete: "This step's checkpoint is incomplete, so it can't be restored.",
  file_not_restorable: "A file at this step was too large to save, so it can't be restored.",
  too_many_changes: "Too many files would need to change to restore this step.",
  blob_missing: "A saved file for this step is no longer available.",
  agent_unavailable: "This agent is not available right now.",
  no_model: "Save a Main AI model and key in Settings → Models first.",
  no_signing_key: "Receipt signing is not set up, so the agent will not act.",
  takeover_active: "Hand the desktop back before rewinding.",
  agent_busy: "This agent is still running another task. Wait for it to finish or cancel it, then try again.",
  restore_failed: "Some files could not be restored. Try again to finish the restore.",
  run_start_failed: "The files were restored, but the new run could not start. Try again.",
  service_unavailable: "The branch could not be created right now. Try again.",
};

export function RewindDialog({ runId, steps, baselineCheckpoint, initialStep, csrfToken, onClose, onCreated }: {
  runId: string; steps: StepView[]; baselineCheckpoint: Checkpoint; initialStep: number; csrfToken: string;
  onClose: () => void; onCreated: (runId: string) => void;
}) {
  const fieldId = useId();
  const options = useMemo(() => [
    { idx: 0, label: "Before step 1", checkpoint: baselineCheckpoint },
    ...steps.map((step) => ({ idx: step.idx, label: `${step.idx}. ${step.action}${step.target ? ` · ${step.target}` : ""}`, checkpoint: step.checkpoint })),
  ], [steps, baselineCheckpoint]);
  const [selected, setSelected] = useState(initialStep);
  const [correction, setCorrection] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = [...correction].length;
  const chosen = options.find((option) => option.idx === selected);
  const canSubmit = !pending && count > 0 && count <= 600 && chosen?.checkpoint === "saved";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setPending(true); setError(null);
    try {
      const response = await fetch(`/api/runs/${runId}/rewind`, {
        method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(75_000),
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ step: selected, correction }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || typeof body.runId !== "string") {
        setError(ERROR_TEXT[typeof body.error === "string" ? body.error : ""] ?? ERROR_TEXT.service_unavailable);
        setPending(false);
        return;
      }
      onCreated(body.runId);
    } catch {
      setError("The branch could not be created. Check that the app is running and try again.");
      setPending(false);
    }
  };

  return (
    <ModalDialog title="Rewind and branch" description="Correct a finished run without changing the original evidence." onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-5">
        <fieldset className="flex min-w-0 flex-col gap-2" disabled={pending}>
          <legend className="text-sm font-medium">1 · Choose a checkpoint</legend>
          <p className="text-xs text-muted-foreground">Select the point to restore agent state and files from.</p>
          <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto pr-1">
            {options.map((option) => {
              const disabled = option.checkpoint !== "saved";
              return (
                <li key={option.idx}>
                  <button type="button" disabled={disabled} aria-pressed={selected === option.idx} onClick={() => setSelected(option.idx)}
                    className={cn("flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
                      selected === option.idx ? "border-border-strong bg-secondary" : "border-transparent hover:bg-surface-hover",
                      option.idx > selected ? "opacity-60" : "")}>
                    <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border font-mono text-[11px] tabular-nums">
                      {option.checkpoint === "saved" ? <Check className="size-3" strokeWidth={2} /> : option.idx}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{option.label}</span>
                      <span className="block text-xs text-text-subtle">
                        {option.checkpoint !== "saved" ? "Can't rewind to this step" : selected === option.idx ? "Restore to this checkpoint" : "Checkpoint saved"}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{option.idx === 0 ? "start" : `step ${option.idx}`}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </fieldset>

        <div className="flex flex-col gap-1">
          <label htmlFor={fieldId} className="text-sm font-medium">2 · Add a correction</label>
          <p className="text-xs text-muted-foreground">Explain the adjustment the agent should apply after restoring this checkpoint.</p>
          <textarea id={fieldId} value={correction} rows={4} maxLength={600} disabled={pending}
            onChange={(event) => setCorrection(event.target.value)}
            placeholder="For example: the March filter also matched an April invoice. Check every date before downloading."
            className="mt-1 min-h-24 w-full rounded-md border border-input bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60" />
          <span className="self-end font-mono text-xs text-muted-foreground tabular-nums">{count}/600</span>
        </div>

        <div className="flex gap-2 rounded-md border border-border bg-surface p-3 text-xs text-muted-foreground">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-corona" strokeWidth={1.5} />
          <p><span className="font-medium text-foreground">Important.</span> Rewind restores agent state and files. It cannot undo sent emails, placed orders or other external actions, and it does not restore the browser page, tabs or logins.</p>
        </div>

        <div className="rounded-md border border-border p-3">
          <p className="text-sm font-medium">Branch preview</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-md border border-border bg-surface-raised px-2 py-1 font-mono">run {runId.slice(0, 8)} <span className="font-sans text-text-subtle">· original</span></span>
            <span aria-hidden className="text-muted-foreground">→</span>
            <span className="rounded-md border border-dashed border-border px-2 py-1">New branch from step {selected}</span>
          </div>
          <p className="mt-2 text-xs text-text-subtle">The original run and all signed receipts remain unchanged.</p>
        </div>

        {error ? <p role="alert" aria-live="polite" className="text-sm text-danger">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button type="submit" disabled={!canSubmit} className="min-w-36" aria-busy={pending}>
            {pending ? <><Loader2 aria-hidden className="size-4 motion-safe:animate-spin" strokeWidth={1.5} />Creating branch…</>
              : <><GitBranch aria-hidden className="size-4" strokeWidth={1.5} />Create branch</>}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}
