"use client";

import { useState } from "react";
import { Check, LoaderCircle, ShieldQuestion, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRemote } from "@/components/history/use-remote";
import { classLabel } from "@/lib/agent/risk";
import type { ApprovalDecision, ApprovalView } from "@/lib/approvals/types";

// TASK-050. The card renders only the approval's display fields; the live state and the decision come from the owner-only
// route. The page name is escaped text, never HTML or a link.
export function ApprovalActions({ approvalId, csrfToken }: { approvalId: string; csrfToken: string }) {
  const url = `/api/approvals/${approvalId}`;
  const { data, error, loading, reload } = useRemote<{ approval: ApprovalView }>(url, (value) => value.approval.state === "pending" ? 3000 : null);
  const [deciding, setDeciding] = useState<ApprovalDecision | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  async function decide(decision: ApprovalDecision) {
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
        setDecisionError("Your session ended. Sign in again, then answer this request.");
        return;
      }
      if (!response.ok) {
        setDecisionError(response.status === 409
          ? "This request is no longer waiting. The latest state is shown above."
          : "Couldn't save your decision. Try again.");
        if (response.status === 409) reload();
        return;
      }
      reload();
    } catch {
      setDecisionError("Couldn't save your decision. Try again.");
    } finally {
      setDeciding(null);
    }
  }

  if (loading && !data) return <p role="status" className="mt-3 text-xs text-muted-foreground">Loading this request…</p>;
  if (error && !data) {
    return <p role="alert" className="mt-3 text-xs text-danger">{error === "not_found" ? "This request is no longer available." : "Couldn't load this request."}</p>;
  }
  if (!data) return null;

  const approval = data.approval;
  const pending = approval.state === "pending";
  return (
    <div className="mt-4 flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <ShieldQuestion aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-corona" />
        <div className="min-w-0">
          <p className="break-words text-sm font-medium">Allow this {classLabel(approval.actionClass).toLowerCase()}?</p>
          <p className="mt-1 break-words text-sm text-muted-foreground">{approval.controlName}</p>
          <p className="mt-1 break-words text-xs text-muted-foreground">
            {approval.site ? <>Site: <span className="font-mono">{approval.site}</span></> : "This page has no site address, so it can only be allowed once."}
          </p>
        </div>
      </div>

      <div aria-live="polite" className="text-sm">
        {approval.state === "allowed_once" && <p className="text-success">Allowed once. The agent continues.</p>}
        {approval.state === "always_allowed" && <p className="text-success">Always allowed for this agent, site and action.</p>}
        {approval.state === "denied" && <p className="text-muted-foreground">Denied. The agent stopped.</p>}
        {approval.state === "expired" && <p className="text-muted-foreground">This request expired. Ask the agent again.</p>}
        {approval.state === "stale" && <p className="text-muted-foreground">The page changed before your decision. The agent stopped.</p>}
      </div>

      {pending ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
          <Button type="button" variant="destructive" disabled={deciding !== null} onClick={() => void decide("deny")}>
            {deciding === "deny" ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <X aria-hidden="true" className="size-4" />}
            Deny
          </Button>
          {approval.canAlwaysAllow && (
            <Button type="button" variant="secondary" disabled={deciding !== null} onClick={() => void decide("always_allow")}>
              {deciding === "always_allow" ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null}
              Always allow
            </Button>
          )}
          <Button type="button" disabled={deciding !== null} onClick={() => void decide("allow_once")}>
            {deciding === "allow_once" ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <Check aria-hidden="true" className="size-4" />}
            Allow once
          </Button>
        </div>
      ) : null}
      {pending ? <p className="text-xs text-muted-foreground">Always allow applies only to this agent, site, and action.</p> : null}
      {decisionError ? <p role="alert" className="text-xs text-danger">{decisionError}</p> : null}
    </div>
  );
}
