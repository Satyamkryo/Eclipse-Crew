"use client";

import { useState } from "react";
import { Check, LoaderCircle, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRemote } from "@/components/history/use-remote";
import type { SkillUpdateDetail } from "@/lib/heal/view";

// TASK-044. The shared review surface: the chat card and the History modal both render it. The diff is fetched from the
// owner-only proposal route, so the card never carries step text or a stale decision.
export function SkillUpdateReview({ proposalId, csrfToken, onDecided }: {
  proposalId: string; csrfToken: string; onDecided?: () => void;
}) {
  const url = `/api/replay-proposals/${proposalId}`;
  const { data, error, loading, reload } = useRemote<{ proposal: SkillUpdateDetail }>(url, () => null);
  const [deciding, setDeciding] = useState<"approve" | "reject" | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  async function decide(decision: "approve" | "reject") {
    if (deciding) return;
    setDeciding(decision);
    setDecisionError(null);
    try {
      const response = await fetch(`${url}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ decision }),
      });
      if (response.status === 401) {
        setDecisionError("Your session ended. Sign in again, then review this update.");
        return;
      }
      if (!response.ok) {
        setDecisionError(response.status === 409
          ? "This proposal changed. Reload and review it again."
          : "Couldn't save your decision. Try again.");
        if (response.status === 409) reload();
        return;
      }
      reload();
      onDecided?.();
    } catch {
      setDecisionError("Couldn't save your decision. Try again.");
    } finally {
      setDeciding(null);
    }
  }

  if (loading && !data) return <p role="status" className="mt-3 text-xs text-muted-foreground">Loading proposed change…</p>;
  if (error && !data) {
    return (
      <div className="mt-3 flex flex-col items-start gap-2" role="alert">
        <p className="text-xs text-danger">{error === "not_found" ? "This proposed update is no longer available." : "Couldn't load the proposed change."}</p>
        {error !== "not_found" ? (
          <Button type="button" variant="secondary" size="sm" onClick={reload}>
            <RefreshCw aria-hidden="true" size={14} strokeWidth={1.5} />
            Try again
          </Button>
        ) : null}
      </div>
    );
  }
  if (!data) return null;

  const proposal = data.proposal;
  const pending = proposal.status === "pending";
  return (
    <div className="mt-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 break-words text-sm font-medium">{proposal.scriptName}</p>
        <span className="text-xs tabular-nums text-muted-foreground">v{proposal.fromVersion} → v{proposal.toVersion}</span>
        {pending ? <span className="rounded-md bg-corona/12 px-2 py-0.5 text-xs text-corona">Needs review</span> : null}
      </div>
      <p className="text-sm leading-6">{proposal.reason}</p>
      <p className="text-xs text-muted-foreground">
        {proposal.changedSteps} of {proposal.oldStepCount} steps changed · {proposal.newStepCount} steps after approval
      </p>
      <div className="overflow-x-auto rounded-md border border-border">
        <ul aria-label="Proposed step change" className="divide-y divide-border font-mono text-xs">
          {proposal.diff.map((row, index) => (
            <li key={`${row.kind}-${row.oldIdx ?? "new"}-${row.newIdx ?? "old"}-${index}`}
              className={row.kind === "removed" ? "bg-danger/12" : row.kind === "added" ? "bg-success/12" : ""}>
              <div className="flex gap-2 px-3 py-2">
                <span aria-hidden="true" className={row.kind === "removed" ? "text-danger" : row.kind === "added" ? "text-success" : ""}>
                  {row.kind === "removed" ? "−" : row.kind === "added" ? "+" : " "}
                </span>
                <span className="min-w-0 break-words">
                  <span className="sr-only">{row.kind === "removed" ? "Removed: " : row.kind === "added" ? "Added: " : "Unchanged: "}</span>
                  <span className="text-muted-foreground tabular-nums">{row.newIdx ?? row.oldIdx ?? index + 1}.</span>{" "}
                  <span className={row.kind === "removed" ? "text-danger" : row.kind === "added" ? "text-success" : ""}>{row.text}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{row.expect}</span>
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div aria-live="polite">
        {proposal.stale && pending ? (
          <p className="text-xs text-danger">This saved replay changed since the proposal. Reject it and run the replay again.</p>
        ) : null}
        {proposal.status === "approved" ? <p className="text-sm text-success">Approved. v{proposal.toVersion} is active.</p> : null}
        {proposal.status === "rejected" ? <p className="text-sm text-muted-foreground">Rejected. v{proposal.fromVersion} stays active.</p> : null}
        {pending ? <p className="text-xs text-muted-foreground">v{proposal.fromVersion} stays active until you approve.</p> : null}
      </div>

      {pending ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" disabled={deciding !== null} onClick={() => void decide("reject")}>
            {deciding === "reject" ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <X aria-hidden="true" className="size-4" />}
            Reject update
          </Button>
          <Button type="button" disabled={deciding !== null || proposal.stale} onClick={() => void decide("approve")}>
            {deciding === "approve" ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <Check aria-hidden="true" className="size-4" />}
            Approve update
          </Button>
        </div>
      ) : null}
      {decisionError ? <p role="alert" className="text-xs text-danger">{decisionError}</p> : null}
    </div>
  );
}
