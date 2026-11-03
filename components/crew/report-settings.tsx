"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock, LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ReportDeliveryResult, ReportSettingsView } from "@/lib/crew/report";

const inputClass = "h-8 w-full min-w-0 rounded-md border border-input bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

export function ReportSettings({ agents, initial, csrfToken }: {
  agents: { id: string; name: string; status: "active" | "paused" }[];
  initial: ReportSettingsView;
  csrfToken: string;
}) {
  const router = useRouter();
  const [settings, setSettings] = useState(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [recipient, setRecipient] = useState(initial.recipientAgentId ?? "");
  const [localTime, setLocalTime] = useState(initial.localTime);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const response = await fetch("/api/crew/report", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ action: "save", enabled, recipientAgentId: recipient || null, localTime }),
      });
      if (response.status === 401) { router.push("/login"); return; }
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(result.error === "recipient_not_owned"
          ? "Choose an agent from this crew."
          : result.error === "invalid_input" ? "Review the recipient and time." : "Couldn't save the report schedule. Try again.");
        return;
      }
      setSettings(result.settings as ReportSettingsView);
      setStatus("Report schedule saved. The next due local time will use it.");
      router.refresh();
    } catch {
      setError("Unable to connect. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function generate() {
    if (sending) return;
    if (recipient !== (settings.recipientAgentId ?? "")) {
      setError("Save the schedule first so Report now uses the recipient you chose.");
      return;
    }
    setSending(true);
    setError(null);
    setStatus(null);
    try {
      const response = await fetch("/api/crew/report", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ action: "generate" }),
      });
      if (response.status === 401) { router.push("/login"); return; }
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(result.error === "recipient_required"
          ? "Choose a recipient agent and save the schedule before sending a report."
          : result.error === "recipient_unavailable" ? "The recipient agent is paused or unavailable. Resume it or choose another agent."
            : "Couldn't generate the report. Try again.");
        return;
      }
      const delivery = result.result as ReportDeliveryResult;
      if (delivery.status === "duplicate") {
        setStatus(`A report for this minute was already sent. Window: ${windowText(delivery.windowStart, delivery.windowEnd, settings.timezone)}.`);
      } else {
        setStatus(`Report sent to the recipient. Window: ${windowText(delivery.windowStart, delivery.windowEnd, settings.timezone)}.`);
        router.refresh();
      }
      if (result.settings) setSettings(result.settings as ReportSettingsView);
    } catch {
      setError("Unable to connect. Try again.");
    } finally {
      setSending(false);
    }
  }

  const recipientAgent = agents.find((agent) => agent.id === recipient);
  const paused = recipientAgent?.status === "paused";

  return (
    <section aria-labelledby="report-settings-heading" className="rounded-lg border border-border bg-card p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="report-settings-heading" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <CalendarClock aria-hidden="true" className="size-4 text-muted-foreground" />Morning report
          </h2>
          <p className="mt-1 max-w-[80ch] text-sm text-muted-foreground">
            A deterministic local summary of recorded work in the previous 24 hours. It makes no model call and never
            sends, posts or changes anything. Disabled until you enable it.
          </p>
        </div>
        <Button type="button" variant="secondary" onClick={generate} disabled={sending || !recipient}>
          {sending && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
          Send report now
        </Button>
      </div>

      <form onSubmit={save} className="mt-4 flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Recipient agent
            <select value={recipient} onChange={(event) => setRecipient(event.target.value)} className={inputClass}>
              <option value="">Choose an agent</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name}{agent.status === "paused" ? " (paused)" : ""}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Local time ({settings.timezone})
            <input type="time" value={localTime} required
              onChange={(event) => setLocalTime(event.target.value)} className={inputClass} />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="size-4 rounded border-input" />
          Enable the scheduled report
        </label>
        {paused && <p className="text-xs text-corona">This recipient is paused. A scheduled report is skipped until it is resumed.</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={saving}>
            {saving && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
            Save schedule
          </Button>
          <span className="text-xs text-muted-foreground">Schedule edits apply from the next occurrence.</span>
        </div>
      </form>

      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      {status && <p role="status" className="mt-3 text-sm text-success">{status}</p>}

      <dl className="mt-4 grid gap-1 text-xs text-muted-foreground">
        <div className="flex flex-wrap gap-2">
          <dt className="font-medium text-foreground">Last delivery</dt>
          <dd>
            {settings.lastDelivery
              ? `${windowText(settings.lastDelivery.scheduledAt, settings.lastDelivery.scheduledAt, settings.timezone)} · ${settings.lastDelivery.state === "delivered" ? "card posted" : "skipped (no card)"}`
              : "None yet"}
          </dd>
        </div>
        {settings.recipientAgentId && settings.recipientStatus && (
          <div className="flex flex-wrap gap-2">
            <dt className="font-medium text-foreground">Current recipient</dt>
            <dd>
              <Link href={`/?agent=${settings.recipientAgentId}`} className="underline underline-offset-4">{settings.recipientName ?? "Agent"}</Link>
              {" · "}{settings.recipientStatus}
            </dd>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <dt className="font-medium text-foreground">Timezone</dt>
          <dd>{settings.timezone}. Windows are exact 24-hour UTC boundaries; the card shows both ends.</dd>
        </div>
      </dl>
    </section>
  );
}

function windowText(start: string, end: string, timezone: string) {
  const format = (value: string) => {
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: timezone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
      }).format(new Date(value));
    } catch {
      return value;
    }
  };
  return start === end ? format(start) : `${format(start)} → ${format(end)}`;
}
