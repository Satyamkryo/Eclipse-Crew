"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { LoaderCircle, Moon, Plus, RefreshCw, Sun, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { StatusChip } from "@/components/ui/status-chip";

type Kind = "sundance" | "moondance";
type Status = "first" | "unchanged" | "changed" | "failed" | "skipped" | "needs_login";
type Via = "fetch" | "browser";
type CheckIn = {
  id: string; name: string; kind: Kind; url: string; via: Via; goal: string | null; urgent: boolean;
  intervalMinutes: number; windowStart: number; windowEnd: number; timezone: string; active: boolean;
  lastStatus: Status | null; lastCheckedAt: string | null; lastChangedAt: string | null; nextCheckAt: string; pendingChanges: number;
};

const DEFAULTS: Record<Kind, { start: number; end: number; interval: number }> = {
  sundance: { start: 7, end: 19, interval: 15 },
  moondance: { start: 19, end: 7, interval: 60 },
};
const INTERVALS = [5, 10, 15, 30, 60, 120, 240];
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const inputClass = "h-8 w-full min-w-0 rounded-md border border-input bg-card px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";
const hour = (value: number) => `${String(value).padStart(2, "0")}:00`;

const ERRORS: Record<string, string> = {
  invalid_url: "Enter a full https:// address without quotes or spaces.",
  invalid_window: "Start and end hours must be different.",
  check_in_limit: "This agent already has 10 check-ins. Delete one first.",
  check_too_soon: "That check ran a moment ago. Try again in 30 seconds.",
  agent_not_found: "This agent is unavailable or does not belong to your account.",
};

function statusChip(item: CheckIn) {
  if (!item.active) return <StatusChip tone="neutral" label="Paused" />;
  switch (item.lastStatus) {
    case "changed": return <StatusChip tone="corona" label="Changed" />;
    case "unchanged": return <StatusChip tone="success" label="Nothing new" />;
    case "first": return <StatusChip tone="success" label="Baseline saved" />;
    case "failed": return <StatusChip tone="danger" label="Couldn't check" />;
    case "skipped": return <StatusChip tone="neutral" label="Skipped" />;
    case "needs_login": return <StatusChip tone="corona" label="Needs you: sign in" />;
    default: return <StatusChip tone="neutral" label="Waiting for first check" />;
  }
}

export function CheckInsPanel({ agentId, agentName, timeZone, csrfToken }: { agentId?: string; agentName?: string; timeZone: string; csrfToken: string }) {
  const router = useRouter();
  const [items, setItems] = useState<CheckIn[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const time = useCallback((value: string | null) => {
    if (!value) return "—";
    try { return new Date(value).toLocaleString([], { timeZone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return value; }
  }, [timeZone]);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!agentId) return;
    try {
      const response = await fetch(`/api/agents/${agentId}/check-ins`, { cache: "no-store", signal });
      if (response.status === 401) { router.push("/login"); return; }
      if (!response.ok) throw new Error();
      const body = await response.json() as { checkIns?: CheckIn[] };
      if (!Array.isArray(body.checkIns)) throw new Error();
      setItems(body.checkIns);
      setLoadError(false);
    } catch { if (!signal?.aborted) setLoadError(true); }
  }, [agentId, router]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) void load(controller.signal); });
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 30_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [load]);

  async function call(id: string, path: string, method: string, body?: unknown) {
    setBusy(id); setError(null); setNotice(null);
    try {
      const response = await fetch(path, {
        method, headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status === 401) { router.push("/login"); return null; }
      const json = await response.json().catch(() => null) as { error?: string; status?: Status } | null;
      if (!response.ok) { setError(ERRORS[json?.error ?? ""] ?? "Couldn't update this check-in. Try again."); return null; }
      await load();
      return json;
    } catch { setError("Unable to connect. Try again."); return null; }
    finally { setBusy(null); }
  }

  async function checkNow(item: CheckIn) {
    const result = await call(item.id, `/api/agents/${agentId}/check-ins/${item.id}/check`, "POST");
    if (!result) return;
    setNotice(({ first: "Baseline saved. Future checks compare against it.", unchanged: "Nothing new on the page.",
      changed: "The page changed. Details are in chat.", failed: "Couldn't read the page. Details are in chat.",
      skipped: "Skipped: the agent is paused, stopped, busy or taken over.",
      needs_login: "This page needs a login. Take over the agent’s desktop, sign in, hand back, then press Check now again." } as Record<Status, string>)[result.status ?? "skipped"]);
  }

  if (!agentId) {
    return <div className="flex h-full min-h-48 items-center justify-center p-6 text-center text-sm text-muted-foreground">Select an agent to manage its check-ins.</div>;
  }

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <section className="flex flex-col gap-3" aria-labelledby="check-ins-heading">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 id="check-ins-heading" className="text-sm font-semibold">Sundance and Moondance check-ins</h3>
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">
              A cheap page check with no AI. {agentName ?? "The agent"} only wakes up when something changed. Sundance alerts you right away during the day; Moondance works quietly overnight and sends one morning summary.
            </p>
          </div>
          {!adding && <Button type="button" size="sm" variant="secondary" onClick={() => { setAdding(true); setError(null); setNotice(null); }}>
            <Plus aria-hidden="true" className="size-4" />New check-in
          </Button>}
        </div>

        {adding && <CheckInForm agentId={agentId} csrfToken={csrfToken} onCancel={() => setAdding(false)}
          onSaved={async () => { setAdding(false); setNotice("Check-in saved. The first check saves a baseline."); await load(); }} />}

        {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}

        {items === null && !loadError && <div role="status" className="flex flex-col gap-2"><span className="sr-only">Loading check-ins</span>
          <div className="h-20 animate-pulse rounded-lg border border-border bg-surface" /></div>}
        {loadError && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
          <span>Couldn&apos;t load check-ins.</span>
          <Button type="button" size="sm" variant="secondary" onClick={() => { setLoadError(false); void load(); }}>Try again</Button>
        </div>}
        {items && items.length === 0 && !adding && <p className="rounded-lg border border-border bg-surface p-4 text-sm text-muted-foreground">
          No check-ins yet. Add one to watch a page, for example a vendor portal or a status page, without spending on the model.
        </p>}

        {items && items.length > 0 && <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {items.map((item) => {
            const Icon = item.kind === "sundance" ? Sun : Moon;
            return (
              <li key={item.id} className="flex flex-col gap-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate text-sm font-medium">{item.name}</span>
                  <span className="text-xs text-muted-foreground">{item.kind === "sundance" ? "Sundance" : "Moondance"}{item.urgent && item.kind === "moondance" ? " · urgent" : ""}</span>
                  <span className="ml-auto">{statusChip(item)}</span>
                </div>
                <p className="truncate font-mono text-xs text-muted-foreground" title={item.url}>{item.url}</p>
                <p className="text-xs text-muted-foreground">{item.via === "browser" ? "Checked in the agent’s browser (keeps your login)" : "Checked with a plain page fetch"}</p>
                {item.active && item.lastStatus === "needs_login" && <div role="status" className="flex flex-col gap-2 rounded-md border border-corona/40 bg-corona/12 p-3 text-sm">
                  <p>This page needs a login. Take over {agentName ?? "the agent"}’s desktop, sign in to the site yourself, press <span className="font-medium">Hand back</span>, then <span className="font-medium">Check now</span>. The agent never types your password.</p>
                  <Link href={`/?agent=${agentId}&view=panel`} className="inline-flex h-8 w-fit items-center rounded-md border border-border-strong bg-surface px-3 text-xs font-medium transition-colors duration-150 hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-ring">Open Desktop</Link>
                </div>}
                {item.goal && <p className="text-sm"><span className="text-muted-foreground">On change: </span>{item.goal}</p>}
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                  <div><dt className="text-muted-foreground">Hours</dt><dd className="tabular-nums">{hour(item.windowStart)}–{hour(item.windowEnd)}</dd></div>
                  <div><dt className="text-muted-foreground">Every</dt><dd className="tabular-nums">{item.intervalMinutes} min, slower when quiet</dd></div>
                  <div><dt className="text-muted-foreground">Last check</dt><dd className="tabular-nums">{time(item.lastCheckedAt)}</dd></div>
                  <div><dt className="text-muted-foreground">Next check</dt><dd className="tabular-nums">{item.active ? time(item.nextCheckAt) : "Paused"}</dd></div>
                </dl>
                {item.kind === "moondance" && item.pendingChanges > 0 && <p className="text-xs text-muted-foreground">{item.pendingChanges} overnight change{item.pendingChanges === 1 ? "" : "s"} for the morning summary.</p>}
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="secondary" disabled={busy !== null} onClick={() => void checkNow(item)}>
                    {busy === item.id ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <RefreshCw aria-hidden="true" className="size-4" />}Check now
                  </Button>
                  <Button type="button" size="sm" variant="secondary" disabled={busy !== null}
                    onClick={() => void call(item.id, `/api/agents/${agentId}/check-ins/${item.id}`, "PATCH", { active: !item.active })}>
                    {item.active ? "Pause" : "Resume"}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" disabled={busy !== null} aria-label={`Delete check-in ${item.name}`}
                    onClick={() => { if (window.confirm(`Delete the check-in "${item.name}"?`)) void call(item.id, `/api/agents/${agentId}/check-ins/${item.id}`, "DELETE"); }}>
                    <Trash2 aria-hidden="true" className="size-4" />Delete
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>}
        <p className="text-xs text-muted-foreground">The page is opened by this agent, so it must be on the agent&apos;s website list. If it needs a login, you sign in once during takeover and the check uses the agent&apos;s browser from then on. Hours use {timeZone}.</p>
      </section>

      <section className="flex flex-col gap-2 border-t border-border pt-6">
        <h3 className="text-sm font-semibold">Scheduled routines</h3>
        <p className="text-sm text-muted-foreground">Ask the agent in chat to create a routine, then confirm it there. Scheduled and upcoming runs live on Schedules.</p>
        <Link href="/schedules" className="inline-flex h-8 w-fit items-center rounded-md border border-border-strong bg-surface px-3 text-xs font-medium transition-colors duration-150 hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-ring">Open Schedules</Link>
      </section>
    </div>
  );
}

function CheckInForm({ agentId, csrfToken, onCancel, onSaved }: { agentId: string; csrfToken: string; onCancel: () => void; onSaved: () => Promise<void> }) {
  const [kind, setKind] = useState<Kind>("sundance");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("https://");
  const [goal, setGoal] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [viaBrowser, setViaBrowser] = useState(false);
  const [start, setStart] = useState(DEFAULTS.sundance.start);
  const [end, setEnd] = useState(DEFAULTS.sundance.end);
  const [interval, setIntervalMinutes] = useState(DEFAULTS.sundance.interval);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function pickKind(next: Kind) {
    setKind(next);
    setStart(DEFAULTS[next].start); setEnd(DEFAULTS[next].end); setIntervalMinutes(DEFAULTS[next].interval);
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (start === end) { setError(ERRORS.invalid_window); return; }
    setSaving(true); setError(null);
    try {
      const response = await fetch(`/api/agents/${agentId}/check-ins`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ name, kind, url, via: viaBrowser ? "browser" : "fetch", goal: goal.trim() || undefined, urgent: kind === "moondance" && urgent, intervalMinutes: interval, windowStart: start, windowEnd: end }),
      });
      const json = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) { setError(ERRORS[json?.error ?? ""] ?? "Couldn't save this check-in. Check the fields and try again."); return; }
      await onSaved();
    } catch { setError("Unable to connect. Try again."); }
    finally { setSaving(false); }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <fieldset className="flex flex-wrap gap-2">
        <legend className="mb-2 text-sm font-medium">Type</legend>
        {(["sundance", "moondance"] as const).map((value) => (
          <label key={value} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${kind === value ? "border-border-strong bg-card" : "border-border"}`}>
            <input type="radio" name="check-in-kind" value={value} checked={kind === value} onChange={() => pickKind(value)} className="size-4" />
            {value === "sundance" ? <Sun aria-hidden="true" className="size-4" /> : <Moon aria-hidden="true" className="size-4" />}
            {value === "sundance" ? "Sundance (day, alerts now)" : "Moondance (night, morning summary)"}
          </label>
        ))}
      </fieldset>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Name</span>
        <input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="Vendor invoices" className={inputClass} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Page to watch</span>
        <input required type="url" inputMode="url" maxLength={2000} value={url} onChange={(event) => setUrl(event.target.value)} className={`${inputClass} font-mono`} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">When it changes, ask the agent to <span className="font-normal text-muted-foreground">(optional)</span></span>
        <textarea maxLength={2000} rows={2} value={goal} onChange={(event) => setGoal(event.target.value)}
          placeholder="Download any new invoice and summarise it for me."
          className="rounded-md border border-input bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
        <span className="text-xs text-muted-foreground">Leave empty to just get a note in chat. The agent runs only on a change, using its normal permissions and budget.</span>
      </label>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1 text-sm"><span className="font-medium">From</span>
          <Select label="Start hour" value={String(start)} onChange={(value) => setStart(Number(value))}>{HOURS.map((h) => <option key={h} value={h}>{hour(h)}</option>)}</Select></div>
        <div className="flex flex-col gap-1 text-sm"><span className="font-medium">Until</span>
          <Select label="End hour" value={String(end)} onChange={(value) => setEnd(Number(value))}>{HOURS.map((h) => <option key={h} value={h}>{hour(h)}</option>)}</Select></div>
        <div className="flex flex-col gap-1 text-sm"><span className="font-medium">Check every</span>
          <Select label="Check interval" value={String(interval)} onChange={(value) => setIntervalMinutes(Number(value))}>
            {INTERVALS.map((minutes) => <option key={minutes} value={minutes}>{minutes < 60 ? `${minutes} min` : `${minutes / 60} h`}</option>)}
          </Select></div>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={viaBrowser} onChange={(event) => setViaBrowser(event.target.checked)} className="mt-0.5 size-4 rounded border-input" />
        <span>This page needs a login<span className="block text-xs text-muted-foreground">Checks use the agent&apos;s browser, which keeps a login you complete during takeover. Only the page&apos;s title, links and buttons are compared, and the agent&apos;s desktop starts for each check. Turned on automatically if a login wall is found.</span></span>
      </label>
      {kind === "moondance" && <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={urgent} onChange={(event) => setUrgent(event.target.checked)} className="size-4 rounded border-input" />
        Urgent: alert me right away instead of waiting for the morning summary
      </label>}
      <p className="text-xs text-muted-foreground">Checks slow down (up to 4x) while nothing changes, speed back up after a change, and are spread by ±10% so several check-ins don&apos;t all fire at the same moment.</p>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={saving}>{saving && <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />}Save check-in</Button>
      </div>
    </form>
  );
}
