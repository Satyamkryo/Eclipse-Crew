"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, Download, LoaderCircle, ShieldAlert, ShieldCheck, Square } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { ModalDialog } from "@/components/workspace/modal-dialog";
import { cn } from "@/lib/utils";

type AgentOption = { id: string; name: string };
type AuditedKind = string;
type AuditEntry = {
  id: string; seq: number; kind: AuditedKind; agentId: string | null; runId: string | null;
  ref: string | null; code: string | null; host: string | null; createdAt: string;
};
type AuditStatus = { signing: boolean; verified: boolean; reason: string | null; entries: number; headSeq: number; headHash: string | null };
type AuditResponse = { entries: AuditEntry[]; hasMore: boolean; status: AuditStatus | null };
type Tab = "events" | "audit";

const KIND_LABEL: Record<string, string> = {
  tripwire: "Canary tripwire", scope_blocked: "Outside task scope", egress_blocked: "Blocked outbound request",
  approval_denied: "Approval denied", agent_stopped: "Agent stopped", crew_stopped: "Crew stopped",
  crew_resumed: "Crew resumed", login: "Sign-in", password_changed: "Password changed", email_changed: "Email changed",
  sessions_revoked: "Other sessions revoked", agent_created: "Agent created", agent_updated: "Agent updated",
  agent_paused: "Agent paused", agent_resumed: "Agent resumed", agent_deleted: "Agent deleted",
  astra_enabled: "Astra Mode enabled", astra_disabled: "Astra Mode disabled", approval_allowed: "Approval allowed",
  permission_revoked: "Saved approval revoked",
};
const STOPPED = new Set(["tripwire", "agent_stopped", "crew_stopped"]);
const DENIED = new Set(["scope_blocked", "egress_blocked", "approval_denied"]);

function outcome(kind: string): { label: string; className: string } {
  if (STOPPED.has(kind)) return { label: "Stopped", className: "bg-danger/12 text-danger" };
  if (DENIED.has(kind)) return { label: "Denied", className: "bg-corona/12 text-corona" };
  return { label: "Recorded", className: "bg-muted text-muted-foreground" };
}

function formatTime(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

export function SecurityCenter({ agents, csrfToken, timeZone }: { agents: AgentOption[]; csrfToken: string; timeZone: string }) {
  const [tab, setTab] = useState<Tab>("events");
  const [agent, setAgent] = useState("");
  const [stopTarget, setStopTarget] = useState("");
  const [range, setRange] = useState<"24h" | "7d" | "30d" | "all">("7d");
  const [data, setData] = useState<AuditResponse | null>(null);
  const [verifiedStatus, setVerifiedStatus] = useState<AuditStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const [version, setVersion] = useState(0);
  const [confirmCrew, setConfirmCrew] = useState(false);
  const [stopping, setStopping] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const nameById = new Map(agents.map((item) => [item.id, item.name]));
  const firstRow = useRef<HTMLTableRowElement>(null);
  const activeTab = useRef(tab);
  const statusLoaded = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ range });
    if (tab === "events") params.set("group", "security");
    if (agent) params.set("agent", agent);
    if (!statusLoaded.current) params.set("verifyStatus", "1");
    fetch(`/api/audit?${params}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return await response.json() as AuditResponse;
      })
      .then((body) => { if (!controller.signal.aborted) {
        setData(body);
        if (body.status) { statusLoaded.current = true; setVerifiedStatus(body.status); }
        setError(false);
      } })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [agent, range, tab, version]);

  async function loadMore() {
    if (!data?.hasMore || loadingMore || !data.entries.length) return;
    const requestedTab = tab;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({
        range, before: String(data.entries[data.entries.length - 1].seq),
      });
      if (requestedTab === "events") params.set("group", "security");
      if (agent) params.set("agent", agent);
      const response = await fetch(`/api/audit?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error();
      const body = await response.json() as AuditResponse;
      if (requestedTab === activeTab.current) {
        setData((current) => current ? { ...body, status: current.status, entries: [...current.entries, ...body.entries] } : current);
      }
    } catch {
      setNotice({ tone: "error", text: "Couldn't load more entries. Try again." });
    } finally {
      setLoadingMore(false);
    }
  }

  async function stopAgent(agentId: string) {
    if (stopping) return;
    setStopping(agentId);
    setNotice(null);
    try {
      const response = await fetch(`/api/agents/${agentId}/stop`, {
        method: "POST", headers: { "x-csrf-token": csrfToken },
      });
      const body = await response.json().catch(() => ({})) as { ok?: boolean; audit?: string; error?: string };
      if (!response.ok) {
        setNotice({ tone: "error", text: body.error === "not_found" ? "This agent no longer exists." : "The stop could not be confirmed." });
        return;
      }
      if (body.ok === false) {
        setNotice({ tone: "error", text: "The agent stopped with warnings; some stop steps were not confirmed." });
        setVersion((value) => value + 1);
        return;
      }
      setNotice({ tone: "ok", text: body.audit === "recorded"
        ? "Agent stopped. The desktop was asked to stop and every live run was cancelled."
        : "Agent stopped. The audit entry could not be written; check Audit signing below." });
      setVersion((value) => value + 1);
    } catch {
      setNotice({ tone: "error", text: "Unable to connect. Try again." });
    } finally {
      setStopping(null);
    }
  }

  async function stopCrew() {
    setConfirmCrew(false);
    setStopping("crew");
    setNotice(null);
    try {
      const response = await fetch("/api/crew/stop", { method: "POST", headers: { "x-csrf-token": csrfToken } });
      const body = await response.json().catch(() => ({})) as { ok?: boolean; audit?: string };
      if (!response.ok) { setNotice({ tone: "error", text: "The crew stop could not be confirmed." }); return; }
      if (body.ok === false) {
        setNotice({ tone: "error", text: "The crew stopped with warnings; some stop steps were not confirmed." });
        setVersion((value) => value + 1);
        return;
      }
      setNotice({ tone: "ok", text: body.audit === "recorded"
        ? "Crew stopped. Every agent was halted and new runs are refused until you resume the crew."
        : "Crew stopped. The audit entry could not be written; check Audit signing below." });
      setVersion((value) => value + 1);
    } catch {
      setNotice({ tone: "error", text: "Unable to connect. Try again." });
    } finally {
      setStopping(null);
    }
  }

  async function resumeCrew() {
    setStopping("resume");
    setNotice(null);
    try {
      const response = await fetch("/api/crew/resume", { method: "POST", headers: { "x-csrf-token": csrfToken } });
      if (!response.ok) { setNotice({ tone: "error", text: "Resume crew could not be confirmed." }); return; }
      setNotice({ tone: "ok", text: "Crew resumed. Agents stay paused until you resume each one." });
      setVersion((value) => value + 1);
    } catch {
      setNotice({ tone: "error", text: "Unable to connect. Try again." });
    } finally {
      setStopping(null);
    }
  }

  const status = verifiedStatus ?? data?.status;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
      <PageHeader icon={ShieldCheck} title="Security Center" subtitle="Security events, the signed audit log and emergency controls."
        action={(
          <a href="/api/audit/export" download className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}>
            <Download aria-hidden="true" className="size-4" strokeWidth={1.5} />Export audit log
          </a>
        )} />

      {status && !status.signing ? (
        <p role="alert" className="rounded-md border border-corona bg-corona/12 px-3 py-2 text-sm text-corona">
          Audit signing is not set up. Run <code className="font-mono">npm run receipt-key</code>. Entries from this period
          cannot be created, so gaps are not detectable.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Security views" className="flex rounded-md border border-border p-0.5">
          {(["events", "audit"] as const).map((id) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id}
              onClick={() => { activeTab.current = id; setTab(id); setSelected(null); setData(null); setLoading(true); setError(false); }}
              className={cn("rounded-sm px-3 py-1 text-sm transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-ring",
                tab === id ? "bg-surface-hover text-foreground" : "text-muted-foreground hover:text-foreground")}>
              {id === "events" ? "Security events" : "Audit log"}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Agent</span>
          <select value={agent} onChange={(event) => setAgent(event.target.value)}
            className="h-8 max-w-48 rounded-md border border-input bg-card px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring">
            <option value="">All agents</option>
            {agents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Range</span>
          <select value={range} onChange={(event) => setRange(event.target.value as typeof range)}
            className="h-8 rounded-md border border-input bg-card px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring">
            <option value="24h">24 hours</option>
            <option value="7d">7 days</option>
            <option value="30d">30 days</option>
            <option value="all">All time</option>
          </select>
        </label>
        {status ? (
          <span className={cn("ml-auto inline-flex items-center gap-1 text-xs", status.verified ? "text-success" : "text-danger")}
            role={status.verified ? "status" : "alert"}>
            {status.verified ? <ShieldCheck aria-hidden="true" className="size-4" strokeWidth={1.5} /> : <ShieldAlert aria-hidden="true" className="size-4" strokeWidth={1.5} />}
            {status.verified ? `Verified ${status.entries} ${status.entries === 1 ? "entry" : "entries"}` : `Chain check failed: ${status.reason ?? "unknown"}`}
          </span>
        ) : null}
      </div>

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section aria-label={tab === "events" ? "Security events" : "Audit log"} className="min-w-0 rounded-lg border border-border bg-card">
          {loading && !data ? (
            <div aria-busy="true" className="flex flex-col gap-2 p-4">
              {[0, 1, 2].map((index) => <div key={index} className="h-10 animate-pulse rounded bg-accent" />)}
              <p role="status" className="sr-only">Loading security events</p>
            </div>
          ) : error && !data ? (
            <div role="alert" className="flex flex-col items-start gap-2 p-6">
              <p className="text-sm text-danger">Security events could not be loaded.</p>
              <button type="button" onClick={() => setVersion((value) => value + 1)} className="text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">Try again</button>
            </div>
          ) : data && data.entries.length === 0 ? (
            <div className="flex min-h-40 flex-col items-center justify-center gap-1 px-6 py-12 text-center">
              <ShieldCheck aria-hidden="true" className="size-5 text-muted-foreground" strokeWidth={1.5} />
              <p className="text-sm font-medium">{tab === "events" ? "No security events yet." : "No audit entries yet."}</p>
              <p className="text-sm text-muted-foreground">Sign-ins, agent changes and blocked actions appear here.</p>
            </div>
          ) : (
            <>
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full table-fixed border-collapse text-sm">
                  <caption className="sr-only">{tab === "events" ? "Security events" : "Audit log"}, newest first</caption>
                  <colgroup>
                    <col className="w-[17%]" /><col className="w-[19%]" /><col className="w-[16%]" /><col className="w-[30%]" /><col className="w-[18%]" />
                  </colgroup>
                  <thead className="sticky top-0 z-10 bg-card">
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th scope="col" className="px-3 py-2 font-medium">Time</th>
                      <th scope="col" className="px-3 py-2 font-medium">Event</th>
                      <th scope="col" className="px-3 py-2 font-medium">Agent</th>
                      <th scope="col" className="px-3 py-2 font-medium">Detail</th>
                      <th scope="col" className="px-3 py-2 font-medium">Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data?.entries.map((entry, index) => {
                      const view = outcome(entry.kind);
                      return (
                        <tr key={entry.id} ref={index === 0 ? firstRow : undefined}
                          className={cn("h-10 cursor-pointer border-b border-border transition-colors duration-150 last:border-b-0 hover:bg-accent",
                            selected?.id === entry.id && "bg-accent")}
                          onClick={() => setSelected(entry)}>
                          <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs tabular-nums text-muted-foreground">{formatTime(entry.createdAt, timeZone)}</td>
                          <td className="truncate px-3 py-1.5">{KIND_LABEL[entry.kind] ?? entry.kind}</td>
                          <td className="truncate px-3 py-1.5">{entry.agentId ? nameById.get(entry.agentId) ?? "Deleted agent" : "—"}</td>
                          <td className="truncate px-3 py-1.5 text-muted-foreground" title={entry.host ?? entry.code ?? undefined}>
                            {entry.host ?? (entry.code ? entry.code.replaceAll("_", " ") : `#${entry.seq}`)}
                          </td>
                          <td className="px-3 py-1.5">
                            <button type="button" onClick={(event) => { event.stopPropagation(); setSelected(entry); }}
                              className={cn("rounded-md px-2 py-0.5 text-xs focus-visible:outline-2 focus-visible:outline-ring", view.className)}>
                              {view.label}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <ul aria-label={tab === "events" ? "Security events" : "Audit log"} className="divide-y divide-border md:hidden">
                {data?.entries.map((entry) => {
                  const view = outcome(entry.kind);
                  return (
                    <li key={entry.id}>
                      <button type="button" onClick={() => setSelected(entry)}
                        className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-accent focus-visible:outline-2 focus-visible:outline-[-2px] focus-visible:outline-ring">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">{KIND_LABEL[entry.kind] ?? entry.kind}</span>
                          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                            {entry.agentId ? nameById.get(entry.agentId) ?? "Deleted agent" : "Account"} · <time dateTime={entry.createdAt}>{formatTime(entry.createdAt, timeZone)}</time>
                          </span>
                        </span>
                        <span className={cn("shrink-0 rounded-md px-2 py-0.5 text-xs", view.className)}>{view.label}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {data?.hasMore ? (
                <div className="border-t border-border p-3">
                  <Button type="button" variant="secondary" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
                    {loadingMore && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}Load more
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </section>

        <aside className="flex flex-col gap-4">
          <section aria-labelledby="event-detail" className="rounded-lg border border-border bg-card p-4">
            <h2 id="event-detail" className="text-sm font-semibold tracking-tight">Event detail</h2>
            {selected ? (
              <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Event</dt><dd className="min-w-0 break-words">{KIND_LABEL[selected.kind] ?? selected.kind}</dd>
                <dt className="text-muted-foreground">Time</dt><dd className="font-mono text-xs tabular-nums">{formatTime(selected.createdAt, timeZone)}</dd>
                <dt className="text-muted-foreground">Agent</dt><dd className="min-w-0 break-words">{selected.agentId ? nameById.get(selected.agentId) ?? "Deleted agent" : "Account"}</dd>
                <dt className="text-muted-foreground">Entry</dt><dd className="font-mono text-xs tabular-nums">#{selected.seq}</dd>
                {selected.code ? <><dt className="text-muted-foreground">Code</dt><dd className="break-words font-mono text-xs">{selected.code}</dd></> : null}
                {selected.host ? <><dt className="text-muted-foreground">Host</dt><dd className="break-words font-mono text-xs">{selected.host}</dd></> : null}
              </dl>
            ) : <p className="mt-2 text-sm text-muted-foreground">Select an entry for its details.</p>}
            {selected?.runId ? (
              <Link href={`/jobs/${selected.runId}`} className="mt-3 inline-block text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">
                Open linked run
              </Link>
            ) : null}
          </section>

          <section aria-labelledby="emergency-controls" className="rounded-lg border border-border bg-card p-4">
            <h2 id="emergency-controls" className="text-sm font-semibold tracking-tight">Emergency controls</h2>
            <p className="mt-1 text-sm text-muted-foreground">These actions do not delete evidence or reverse external changes.</p>
            <div className="mt-4 flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">Agent</span>
                <select id="stop-agent" value={stopTarget} onChange={(event) => setStopTarget(event.target.value)}
                  className="h-8 rounded-md border border-input bg-card px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring">
                  <option value="">Select an agent</option>
                  {agents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              <Button type="button" variant="destructive" disabled={!stopTarget || stopping !== null} onClick={() => void stopAgent(stopTarget)}>
                {stopping === stopTarget && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
                <Square aria-hidden="true" className="size-3.5" />Stop agent
              </Button>
              <Button type="button" variant="destructive" disabled={stopping !== null} onClick={() => setConfirmCrew(true)}>
                {stopping === "crew" ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> : <Square aria-hidden="true" className="size-3.5" />}
                Stop crew
              </Button>
              <Button type="button" variant="secondary" disabled={stopping !== null} onClick={() => void resumeCrew()}>
                {stopping === "resume" ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> : <Check aria-hidden="true" className="size-3.5" />}
                Resume crew
              </Button>
            </div>
            {notice ? <p role={notice.tone === "error" ? "alert" : "status"} className={cn("mt-3 text-sm", notice.tone === "error" ? "text-danger" : "text-muted-foreground")}>{notice.text}</p> : null}
          </section>
        </aside>
      </div>

      {confirmCrew ? (
        <ModalDialog title="Stop the whole crew?" onClose={() => setConfirmCrew(false)}
          description={`This halts ${agents.length === 1 ? "1 agent" : `${agents.length} agents`}: live runs are cancelled, every desktop is asked to stop and every agent is paused. New runs are refused until you resume the crew.`}>
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">These actions do not delete evidence or reverse external changes.</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setConfirmCrew(false)}>Cancel</Button>
              <Button type="button" variant="destructive" onClick={() => void stopCrew()}>Stop crew</Button>
            </div>
          </div>
        </ModalDialog>
      ) : null}
    </div>
  );
}
