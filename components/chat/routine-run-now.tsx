"use client";

import { useEffect, useState } from "react";
import { LoaderCircle, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  executionStatusText,
  type RoutineExecutionState,
  type RoutineExecutionView,
} from "@/lib/routines/execution-view";

const ACTIVE: RoutineExecutionState[] = ["queued", "retrying", "starting", "running"];

export function RoutineRunNow({ routineId, csrfToken, onStarted, className }: {
  routineId: string; csrfToken: string; onStarted?: () => void; className?: string;
}) {
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [view, setView] = useState<RoutineExecutionView | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!executionId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/routines/${routineId}/executions/${executionId}`, {
          cache: "no-store", signal: controller.signal,
        });
        if (response.status === 404) {
          if (!cancelled) setError("This execution is no longer available.");
          return;
        }
        if (!response.ok) throw new Error();
        const next = await response.json() as RoutineExecutionView;
        if (cancelled) return;
        setView(next);
        setError(null);
        if (ACTIVE.includes(next.state)) timer = setTimeout(() => { void load(); }, 2000);
      } catch {
        if (cancelled) return;
        setError("Couldn't refresh this run. Retrying…");
        timer = setTimeout(() => { void load(); }, 2000);
      }
    };
    void load();
    return () => { cancelled = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [executionId, routineId]);

  async function start() {
    if (starting || (view && ACTIVE.includes(view.state))) return;
    setStarting(true);
    setError(null);
    setView(null);
    try {
      const response = await fetch(`/api/routines/${routineId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({}),
      });
      if (response.status === 202) {
        const body = await response.json() as { executionId?: unknown };
        if (typeof body.executionId !== "string") throw new Error();
        setExecutionId(body.executionId);
        setView({ executionId: body.executionId, state: "queued", retryCount: 0, runId: null, detail: null });
        window.dispatchEvent(new CustomEvent("eclipse-notify", {
          detail: { title: "Run started", text: "Routine queued. Watch progress in Mission Control.", actionLabel: "Open Mission Control", actionHref: "/mission-control" },
        }));
        onStarted?.();
        return;
      }
      if (response.status === 429) {
        setError("Too many runs started at once. Wait a minute and try again.");
        return;
      }
      if (response.status === 404) {
        setError("This routine is no longer available.");
        return;
      }
      throw new Error();
    } catch {
      setError("Couldn't start this routine. Try again.");
    } finally {
      setStarting(false);
    }
  }

  const active = Boolean(view && ACTIVE.includes(view.state));
  const status = view ? executionStatusText(view) : null;
  return (
    <div className={cn("mt-4 flex flex-col items-end gap-2", className)}>
      <Button type="button" variant="secondary" onClick={start} disabled={starting || active}
        aria-label="Run routine now">
        {starting ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <Play aria-hidden="true" className="size-4" />}
        Run now
      </Button>
      <div aria-live="polite" className="text-right">
        {status && <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">{status.label}</span> · {status.detail}</p>}
      </div>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </div>
  );
}
