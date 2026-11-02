"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { diffSnapshots } from "@/lib/memory/diff";
import { DiffView } from "./diff-view";
import { UndoNotice } from "./undo-notice";

type Change = {
  id: string; agentId: string; doc: "user" | "memory" | "private"; scope: "global" | "agent" | "private";
  title: string; body: string; reason: string; flags: string[]; state: "pending" | "approved" | "rejected";
  expired: boolean;
};

const DOC_LABEL = { user: "USER.md", memory: "MEMORY.md", private: "Private notes" } as const;

export function ChangeActions({ changeId, csrfToken }: { changeId: string; csrfToken: string }) {
  const router = useRouter();
  const [change, setChange] = useState<Change | null>(null);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [undoVersion, setUndoVersion] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/memory/changes/${changeId}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return await response.json() as { change: Change };
      })
      .then((body) => { if (!controller.signal.aborted) setChange(body.change); })
      .catch(() => { if (!controller.signal.aborted) setMessage({ tone: "error", text: "Couldn't load this memory request." }); });
    return () => controller.abort();
  }, [changeId]);

  async function decide(decision: "approve" | "reject") {
    if (busy) return;
    setBusy(decision);
    setMessage(null);
    try {
      const response = await fetch(`/api/memory/changes/${changeId}/decision`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ decision }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string; versionId?: string };
      if (!response.ok) {
        setMessage({ tone: "error", text: body.error === "expired" ? "This request expired. Nothing was saved."
          : body.error === "already_decided" ? "This request was already decided."
            : body.error === "over_cap" ? "This entry no longer fits under the document's cap."
              : "Couldn't decide this request. Try again." });
        return;
      }
      setMessage({ tone: "ok", text: decision === "approve" ? "Memory change saved." : "Memory change rejected." });
      if (decision === "approve" && body.versionId) setUndoVersion(body.versionId);
      setChange((current) => current ? { ...current, state: decision === "approve" ? "approved" : "rejected" } : current);
      router.refresh();
    } catch {
      setMessage({ tone: "error", text: "Unable to connect. Try again." });
    } finally {
      setBusy(null);
    }
  }

  if (!change && !message) return <p role="status" className="mt-3 text-sm text-muted-foreground">Loading request…</p>;
  if (!change) return <p role="alert" className="mt-3 text-sm text-danger">{message?.text}</p>;
  if (change.state !== "pending" || change.expired) {
    return (
      <p role="status" className="mt-3 text-sm text-muted-foreground">
        {change.state === "approved" ? "Memory change saved." : change.state === "rejected" ? "Memory change rejected." : "This request expired. Nothing was saved."}
      </p>
    );
  }

  return (
    <div className="mt-3 flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">{DOC_LABEL[change.doc]} · {change.scope} · Why: {change.reason}</p>
      {change.flags.includes("external_address") ? (
        <p role="alert" className="rounded-md border border-corona bg-corona/12 px-2 py-1 text-xs text-corona">
          Contains an address. Check it before approving.
        </p>
      ) : null}
      <DiffView lines={diffSnapshots(null, { title: change.title, body: change.body, pinned: false, status: "active", scope: change.scope })} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => void decide("reject")}>
          {busy === "reject" ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> : null}Reject
        </Button>
        <Button type="button" disabled={busy !== null} onClick={() => void decide("approve")}>
          {busy === "approve" ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> : null}Approve memory change
        </Button>
      </div>
      {message ? <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "text-sm text-danger" : "text-sm text-muted-foreground"}>{message.text}</p> : null}
      {undoVersion ? <UndoNotice versionId={undoVersion} csrfToken={csrfToken} onUndone={() => { setUndoVersion(null); router.refresh(); }} /> : null}
    </div>
  );
}
