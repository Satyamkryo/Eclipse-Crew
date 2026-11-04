"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CompactStepRow } from "@/components/history/step-row";
import { formatCost } from "@/components/history/format";
import type { LiveRun } from "@/lib/runs/live";

function elapsed(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// TASK-083. The live card is rendered from the owner-scoped live route and is never stored as a message.
export function LiveRunCard({ agentId, csrfToken, active }: { agentId: string; csrfToken: string; active: boolean }) {
  const [live, setLive] = useState<LiveRun | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [now, setNow] = useState(() => Date.now());
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/api/agents/${agentId}/live`, { cache: "no-store" });
        if (!response.ok) throw new Error("live");
        const body = await response.json() as { live?: LiveRun | null };
        if (disposed) return;
        setLive(body.live ?? null); setState("ready");
      } catch { if (!disposed) setState("error"); }
      finally { if (!disposed) timer = setTimeout(poll, active ? 2000 : 10000); }
    };
    void poll();
    return () => { disposed = true; if (timer) clearTimeout(timer); };
  }, [agentId, active]);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  async function cancel() {
    if (!live || cancelling) return;
    setCancelling(true); setCancelError(null);
    try {
      const response = await fetch(`/api/jobs/${live.runId}/cancel`, { method: "POST", cache: "no-store", headers: { "x-csrf-token": csrfToken } });
      if (!response.ok) throw new Error("cancel");
    } catch { setCancelError("Couldn't stop this run. Try again."); }
    finally { setCancelling(false); }
  }

  if (state === "error" && !live) {
    return <p className="px-4 py-2 text-xs text-danger" role="status">Couldn&apos;t load live steps. Retrying.</p>;
  }
  if (state === "loading" && !live) {
    return <div aria-hidden className="mx-4 my-3 h-16 animate-pulse rounded-md border border-border bg-surface" />;
  }
  if (!live) return null;

  return (
    <section aria-live="polite" className="mx-4 my-3 rounded-md border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="inline-flex items-center gap-2 text-xs font-medium">
          <span aria-hidden className="size-2 rounded-full bg-foreground motion-safe:animate-pulse" />Running
        </span>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {elapsed(live.startedAt, now)} · {formatCost(live.costMicroUsd)}
        </span>
      </div>
      {live.steps.length ? <ul>{live.steps.map((step) => <CompactStepRow key={step.idx} step={step} />)}</ul>
        : <p className="px-3 py-2 text-xs text-muted-foreground">Starting…</p>}
      {live.helpers.map((helper) => (
        <div key={helper.runId} className="ml-6 border-l border-border pl-2">
          <p className="flex flex-wrap items-center gap-2 px-2 py-1 text-xs font-medium">
            <span aria-hidden className={`size-1.5 rounded-full ${helper.state === "running" ? "bg-foreground motion-safe:animate-pulse" : "bg-muted-foreground"}`} />
            {helper.label} · {helper.state === "running" ? "Running" : helper.state === "finished" ? "Finished" : "Stopped"}
          </p>
          {helper.steps.length ? <ul>{helper.steps.map((step) => <CompactStepRow key={step.idx} step={step} />)}</ul>
            : <p className="px-2 pb-1 text-xs text-muted-foreground">Starting…</p>}
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-3 py-2">
        {cancelError ? <p className="mr-auto text-xs text-danger" role="alert">{cancelError}</p> : null}
        <Link href={`/jobs/${live.runId}`} className="text-xs underline underline-offset-4">Open in History</Link>
        <Button type="button" variant="secondary" size="sm" onClick={() => void cancel()} disabled={cancelling}>
          {cancelling ? <Loader2 aria-hidden className="size-4 motion-safe:animate-spin" strokeWidth={1.5} /> : null}
          {cancelling ? "Stopping…" : "Cancel"}
        </Button>
      </div>
    </section>
  );
}
