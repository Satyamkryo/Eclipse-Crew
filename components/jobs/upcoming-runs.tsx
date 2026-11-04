"use client";

import { useEffect, useState } from "react";
import { CalendarClock, Loader2, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { RoutineRunNow } from "@/components/chat/routine-run-now";
import { AstraBadge } from "@/components/ui/astra-badge";
import { cn } from "@/lib/utils";
import type { PausedRoutine, RoutineCatchUp, UpcomingRoutine, UpcomingView } from "@/lib/jobs/view";

const CATCH_UP_LABEL: Record<RoutineCatchUp, string> = {
  skip: "Skip missed runs",
  run_once: "Run once after downtime",
  run_all: "Run every missed occurrence",
};

const timeOnly = (iso: string, timeZone: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(date);
  }
};

const costCap = (cents: number) => `$${(cents / 100).toFixed(2)}`;

type Selected = { routineId: string; kind: "active" | "paused" };

function Details({ routine }: { routine: UpcomingRoutine | PausedRoutine }) {
  const fields: [string, string][] = [
    ["Timezone", routine.timezone],
    ["Schedule", routine.schedule],
    ["Routine", routine.label],
    ["Agent", routine.agentName],
    ["Cost cap", costCap(routine.budgetCents)],
    ["Missed runs", CATCH_UP_LABEL[routine.catchUp]],
  ];
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      {fields.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function UpcomingRuns({ agent, csrfToken }: { agent: string; csrfToken: string }) {
  const [days, setDays] = useState<"1" | "7" | "30">("7");
  const [data, setData] = useState<UpcomingView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<Selected | null>(null);
  // Live: schedules fire on the minute tick; re-check every 30s while visible.
  // (The Jobs list keeps its 5s poll, but only while a run is actually running.)
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") setVersion((value) => value + 1); }, 30000);
    return () => window.clearInterval(timer);
  }, []);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [version, setVersion] = useState(0);

  const select = (next: Selected | null) => { setSelected(next); setConfirmingDelete(false); };

  async function remove(routineId: string) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/routines/${routineId}`, {
        method: "DELETE", cache: "no-store", headers: { "x-csrf-token": csrfToken },
      });
      if (response.ok) {
        window.dispatchEvent(new CustomEvent("eclipse-notify", {
          detail: { title: "Routine deleted", text: "Past runs stay in History. The schedule is gone.", actionLabel: "Open Schedules", actionHref: "/schedules" },
        }));
        select(null);
        setVersion((value) => value + 1);
        return;
      }
      setMessage({ tone: "error", text: "Couldn't delete this routine. Try again." });
    } catch {
      setMessage({ tone: "error", text: "Couldn't delete this routine. Try again." });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ days });
    if (agent) params.set("agent", agent);
    fetch(`/api/jobs/upcoming?${params}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return await response.json() as UpcomingView;
      })
      .then((view) => { if (!controller.signal.aborted) { setData(view); setError(false); } })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [days, agent, version]);

  const activeSelected = selected?.kind === "active"
    ? data?.days.flatMap((day) => day.runs).find((run) => run.routineId === selected.routineId) ?? null
    : null;
  const pausedSelected = selected?.kind === "paused"
    ? data?.paused.find((routine) => routine.routineId === selected.routineId) ?? null
    : null;

  async function toggle(routineId: string, active: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/routines/${routineId}/active`, {
        method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ active }),
      });
      if (response.ok) {
        setMessage({ tone: "ok", text: active ? "Routine resumed." : "Routine paused." });
        window.dispatchEvent(new CustomEvent("eclipse-notify", {
          detail: { title: active ? "Routine resumed" : "Routine paused", text: active ? "It will run on its next schedule." : "It will skip schedules until resumed.", actionLabel: "Open Schedules", actionHref: "/schedules" },
        }));
        setSelected({ routineId, kind: active ? "active" : "paused" });
        setConfirmingDelete(false);
        setVersion((value) => value + 1);
        return;
      }
      let code = "";
      try { code = (await response.json() as { error?: string }).error ?? ""; } catch { code = ""; }
      setMessage({ tone: "error", text: code === "once_expired"
        ? "This one-off time has passed. Ask the agent for a new schedule."
        : "Couldn't change this routine. Try again." });
      setVersion((value) => value + 1);
    } catch {
      setMessage({ tone: "error", text: "Couldn't change this routine. Try again." });
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) {
    return (
      <div aria-busy="true" className="flex flex-col gap-4">
        {[0, 1].map((index) => <div key={index} className="h-32 animate-pulse rounded-lg bg-accent" />)}
        <p role="status" className="sr-only">Loading upcoming runs</p>
      </div>
    );
  }
  if (error && !data) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 rounded-lg border border-border bg-card p-6">
        <p className="text-sm text-danger">Upcoming runs could not be loaded.</p>
        <button type="button" onClick={() => setVersion((value) => value + 1)} className="text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">Try again</button>
      </div>
    );
  }
  const view = data as UpcomingView;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Show</span>
            <Select label="Show range" value={days} onChange={(value) => setDays(value as "1" | "7" | "30")}>
              <option value="1">Next 24 hours</option>
              <option value="7">Next 7 days</option>
              <option value="30">Next 30 days</option>
            </Select>
          </label>
          <p className="text-xs text-muted-foreground">Timezone: {view.timezone}</p>
        </div>

        {view.days.length === 0 ? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-1 rounded-lg border border-border bg-card px-6 py-12 text-center">
            <CalendarClock aria-hidden className="size-5 text-muted-foreground" strokeWidth={1.5} />
            <p className="text-sm font-medium">No upcoming runs</p>
            <p className="text-sm text-muted-foreground">Confirm a routine in chat to schedule one.</p>
          </div>
        ) : view.days.map((day) => (
          <section key={day.date} aria-labelledby={`day-${day.date}`} className="rounded-lg border border-border bg-card">
            <h2 id={`day-${day.date}`} className="border-b border-border px-4 py-3 text-sm font-semibold tracking-tight">{day.label}</h2>
            <ul className="divide-y divide-border">
              {day.runs.map((run) => (
                <li key={`${run.routineId}-${run.startAt}`}>
                  <button type="button" onClick={() => select({ routineId: run.routineId, kind: "active" })}
                    className={cn("flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
                      selected?.routineId === run.routineId && selected.kind === "active" && "bg-accent")}>
                    <span className="w-14 shrink-0 font-mono text-sm tabular-nums">{timeOnly(run.startAt, view.timezone)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{run.label}</span>
                      <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-text-subtle">
                        <span className="truncate">{run.agentName}</span>
                        {run.astraMode && <AstraBadge />}
                        <span className="shrink-0">· {run.timezone}</span>
                      </span>
                    </span>
                    <span className="rounded-md bg-success/12 px-2 py-0.5 text-xs text-success">Active</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {view.truncated ? <p className="text-xs text-muted-foreground">Showing the first {view.days.reduce((sum, day) => sum + day.runs.length, 0)} runs. Narrow the range or agent to see the rest.</p> : null}
      </div>

      <aside className="flex flex-col gap-4">
        <section aria-labelledby="schedule-details" className="rounded-lg border border-border bg-card p-4">
          <h2 id="schedule-details" className="text-sm font-semibold tracking-tight">Schedule details</h2>
          {activeSelected ? (
            <>
              <div className="mt-3"><Details routine={activeSelected} /></div>
              <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
                <Button type="button" variant="secondary" size="sm" className="min-w-[6.5rem]" disabled={busy}
                  onClick={() => void toggle(activeSelected.routineId, false)}>
                  {busy ? <Loader2 aria-hidden className="size-4 motion-safe:animate-spin" strokeWidth={1.5} /> : <Pause aria-hidden className="size-4" strokeWidth={1.5} />}
                  Pause
                </Button>
                <RoutineRunNow key={activeSelected.routineId} routineId={activeSelected.routineId} csrfToken={csrfToken} className="mt-0" />
              </div>
              {confirmingDelete ? (
                <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Confirm routine delete">
                  <span className="text-xs text-muted-foreground">Delete this schedule? Past runs stay.</span>
                  <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => void remove(activeSelected.routineId)}>Delete</Button>
                  <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmingDelete(false)}>Keep</Button>
                </div>
              ) : (
                <Button type="button" variant="ghost" size="sm" className="mt-2 text-danger" disabled={busy} onClick={() => setConfirmingDelete(true)}>Delete routine</Button>
              )}
            </>
          ) : pausedSelected ? (
            <>
              <div className="mt-3"><Details routine={pausedSelected} /></div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button type="button" variant="secondary" size="sm" className="min-w-[6.5rem]" disabled={busy}
                  onClick={() => void toggle(pausedSelected.routineId, true)}>
                  {busy ? <Loader2 aria-hidden className="size-4 motion-safe:animate-spin" strokeWidth={1.5} /> : <Play aria-hidden className="size-4" strokeWidth={1.5} />}
                  Resume
                </Button>
                <RoutineRunNow key={pausedSelected.routineId} routineId={pausedSelected.routineId} csrfToken={csrfToken} className="mt-0" />
              </div>
              {confirmingDelete ? (
                <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Confirm routine delete">
                  <span className="text-xs text-muted-foreground">Delete this schedule? Past runs stay.</span>
                  <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => void remove(pausedSelected.routineId)}>Delete</Button>
                  <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmingDelete(false)}>Keep</Button>
                </div>
              ) : (
                <Button type="button" variant="ghost" size="sm" className="mt-2 text-danger" disabled={busy} onClick={() => setConfirmingDelete(true)}>Delete routine</Button>
              )}
            </>
          ) : <p className="mt-2 text-sm text-muted-foreground">Select a routine to see its schedule, agent, cost cap and missed-run policy. Test with Run now before relying on the schedule.</p>}
          {message ? <p role={message.tone === "error" ? "alert" : "status"} className={cn("mt-3 text-xs", message.tone === "error" ? "text-danger" : "text-muted-foreground")}>{message.text}</p> : null}
        </section>

        <section aria-labelledby="paused-routines" className="rounded-lg border border-border bg-card p-4">
          <h2 id="paused-routines" className="text-sm font-semibold tracking-tight">Paused routines</h2>
          {view.paused.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No paused routines.</p> : (
            <ul className="mt-2 divide-y divide-border">
              {view.paused.map((routine) => (
                <li key={routine.routineId} className="py-3 first:pt-0 last:pb-0">
                  <button type="button" onClick={() => select({ routineId: routine.routineId, kind: "paused" })}
                    className="w-full text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                    <span className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-sm">{routine.label}</span>
                      <span className="rounded-md border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">Paused</span>
                    </span>
                    <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-text-subtle">
                      <span className="truncate">{routine.agentName}</span>
                      {routine.astraMode && <AstraBadge />}
                      <span className="shrink-0">· {routine.schedule}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </div>
  );
}
