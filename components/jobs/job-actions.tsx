"use client";

import { useState } from "react";
import { Loader2, Play, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/workspace/modal-dialog";
import { shortRunId, type JobOutcome, type JobTrigger } from "@/lib/jobs/view";

const RETRY_REFUSAL: Record<string, string> = {
  already_verified: "This run is already verified; there is nothing to retry.",
  running: "This run is still running.",
  not_retryable: "This run cannot be repeated from the dashboard.",
  already_retried: "A newer attempt already exists for this run.",
  agent_busy: "The agent is busy with another run. Try again when it finishes.",
  run_not_found: "This run is no longer available.",
};

const CANCEL_REFUSAL: Record<string, string> = {
  not_running: "This run is no longer running.",
  run_not_found: "This run is no longer available.",
};

function retryReason(trigger: JobTrigger, outcome: JobOutcome, routineId: string | null): string | null {
  if (outcome === "verified") return "Already verified.";
  if (outcome === "running") return "Still running.";
  if (outcome === "not_sealed") return "This run has no sealed proof.";
  if (trigger === "chat") return null;
  if (trigger === "schedule" || trigger === "run_now") {
    return routineId ? null : "This run is not linked to a routine.";
  }
  if (trigger === "replay") return "A replay's typed text is never stored, so it cannot be repeated from here.";
  if (trigger === "branch") return "A branch is a deliberate correction, not a retry.";
  return "A self-heal attempt is not retried from here.";
}

export function JobActions({ runId, label, outcome, trigger, routineId, csrfToken, onChanged, showOpen = true }: {
  runId: string; label: string; outcome: JobOutcome; trigger: JobTrigger; routineId: string | null;
  csrfToken: string; onChanged?: () => void; showOpen?: boolean;
}) {
  const [busy, setBusy] = useState<"retry" | "cancel" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const reason = retryReason(trigger, outcome, routineId);

  async function post(action: "retry" | "cancel") {
    setBusy(action);
    setMessage(null);
    try {
      const response = await fetch(`/api/jobs/${runId}/${action}`, {
        method: "POST", cache: "no-store", headers: { "x-csrf-token": csrfToken },
      });
      let body: { error?: string } | null = null;
      try { body = await response.json() as { error?: string }; } catch { body = null; }
      if (response.ok) {
        setMessage({ tone: "ok", text: action === "retry" ? "Retry started." : "Run cancelled." });
        onChanged?.();
        return;
      }
      const text = action === "retry"
        ? RETRY_REFUSAL[body?.error ?? ""] ?? "Couldn't retry this run. Try again."
        : CANCEL_REFUSAL[body?.error ?? ""] ?? "Couldn't cancel this run. Try again.";
      setMessage({ tone: "error", text });
      onChanged?.();
    } catch {
      setMessage({ tone: "error", text: action === "retry" ? "Couldn't retry this run. Try again." : "Couldn't cancel this run. Try again." });
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="sm" className="min-w-[6.5rem]" disabled={busy !== null || reason !== null}
          title={reason ?? "Start a new attempt"} onClick={() => void post("retry")}>
          {busy === "retry" ? <Loader2 aria-hidden className="size-4 motion-safe:animate-spin" strokeWidth={1.5} /> : <RotateCcw aria-hidden className="size-4" strokeWidth={1.5} />}
          Retry
        </Button>
        <Button type="button" variant="secondary" size="sm" className="min-w-[6.5rem]" disabled={busy !== null || outcome !== "running"}
          title={outcome === "running" ? "Stop this run at its next safe point" : "Only a running job can be cancelled"}
          onClick={() => setConfirming(true)}>
          {busy === "cancel" ? <Loader2 aria-hidden className="size-4 motion-safe:animate-spin" strokeWidth={1.5} /> : <X aria-hidden className="size-4" strokeWidth={1.5} />}
          Cancel
        </Button>
        {showOpen ? (
          <Button type="button" variant="ghost" size="sm" asChild>
            <a href={`/jobs/${runId}`}><Play aria-hidden className="size-4" strokeWidth={1.5} />Open run</a>
          </Button>
        ) : null}
      </div>
      {message ? <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "text-xs text-danger" : "text-xs text-muted-foreground"}>{message.text}</p> : null}
      {confirming ? (
        <ModalDialog title="Cancel this run?" description={`${shortRunId(runId)} · ${label}`} onClose={() => setConfirming(false)}>
          <p className="text-sm text-muted-foreground">
            The agent stops at its next safe point. Steps already sent to the desktop, such as a click or a sent email, are not taken back.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>Keep running</Button>
            <Button type="button" variant="destructive" disabled={busy === "cancel"} onClick={() => void post("cancel")}>
              {busy === "cancel" ? <Loader2 aria-hidden className="size-4 motion-safe:animate-spin" strokeWidth={1.5} /> : null}
              Cancel run
            </Button>
          </div>
        </ModalDialog>
      ) : null}
    </div>
  );
}
