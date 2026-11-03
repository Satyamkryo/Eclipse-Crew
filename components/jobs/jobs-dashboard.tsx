"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ListChecks, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { RoutineRunNow } from "@/components/chat/routine-run-now";
import { cn } from "@/lib/utils";
import type { JobOutcomeFilter, JobRange, JobRow } from "@/lib/jobs/view";
import { JobActions } from "./job-actions";
import { JobSummary } from "./job-summary";
import { JobsTable } from "./jobs-table";
import { UpcomingRuns } from "./upcoming-runs";

type Tab = "all" | "upcoming" | "failed";
const TABS: { id: Tab; label: string }[] = [
  { id: "all", label: "All jobs" },
  { id: "upcoming", label: "Upcoming runs" },
  { id: "failed", label: "Failed" },
];
const OUTCOME_OPTIONS: { value: JobOutcomeFilter; label: string }[] = [
  { value: "all", label: "All outcomes" },
  { value: "running", label: "Running" },
  { value: "verified", label: "Verified" },
  { value: "finished", label: "Finished" },
  { value: "needs_you", label: "Needs you" },
  { value: "failed", label: "Failed" },
  { value: "canceled", label: "Canceled" },
];
const RANGE_OPTIONS: { value: JobRange; label: string }[] = [
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "all", label: "All time" },
];

export function JobsDashboard({ agents, csrfToken, timeZone }: {
  agents: { id: string; name: string }[]; csrfToken: string; timeZone: string;
}) {
  const [tab, setTab] = useState<Tab>("all");
  const [agent, setAgent] = useState("");
  const [outcome, setOutcome] = useState<JobOutcomeFilter>("all");
  const [range, setRange] = useState<JobRange>("7d");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const effectiveOutcome: JobOutcomeFilter = tab === "failed" ? "failed" : outcome;
  const filtered = Boolean(agent) || effectiveOutcome !== "all" || range !== "7d" || Boolean(debouncedSearch);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (tab === "upcoming") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const params = new URLSearchParams();
    if (agent) params.set("agent", agent);
    params.set("outcome", effectiveOutcome);
    params.set("range", range);
    if (debouncedSearch) params.set("q", debouncedSearch);
    const url = `/api/jobs?${params.toString()}`;
    const load = async () => {
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error();
        const data = await response.json() as { jobs: JobRow[]; nextCursor: string | null };
        if (controller.signal.aborted) return;
        setJobs(data.jobs);
        setNextCursor(data.nextCursor);
        setError(false);
        setLoading(false);
        if (data.jobs.some((job) => job.outcome === "running")) timer = setTimeout(() => { void load(); }, 5000);
      } catch {
        if (!controller.signal.aborted) { setError(true); setLoading(false); }
      }
    };
    void load();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [tab, agent, effectiveOutcome, range, debouncedSearch, reloadKey]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams();
      if (agent) params.set("agent", agent);
      params.set("outcome", effectiveOutcome);
      params.set("range", range);
      if (debouncedSearch) params.set("q", debouncedSearch);
      params.set("cursor", nextCursor);
      const response = await fetch(`/api/jobs?${params.toString()}`, { cache: "no-store" });
      if (!response.ok) throw new Error();
      const data = await response.json() as { jobs: JobRow[]; nextCursor: string | null };
      setJobs((previous) => [...previous, ...data.jobs]);
      setNextCursor(data.nextCursor);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  function clearFilters() {
    setTab("all");
    setAgent("");
    setOutcome("all");
    setRange("7d");
    setSearch("");
    setDebouncedSearch("");
  }

  const selected = jobs.find((job) => job.runId === selectedRunId) ?? null;
  const runningCount = jobs.filter((job) => job.outcome === "running").length;

  return (
    <div className="w-full bg-background text-foreground">
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
        <PageHeader icon={ListChecks} title="Jobs" subtitle="Crew-wide run status, outcomes and cost receipts."
          action={(
            <Button type="button" variant="secondary" size="sm" onClick={() => setTab("upcoming")}>
              <ListChecks aria-hidden className="size-4" strokeWidth={1.5} />Upcoming runs
            </Button>
          )} />
        <div role="tablist" aria-label="Jobs views" className="flex gap-1 border-b border-border">
          {TABS.map((item) => (
            <button key={item.id} id={`jobs-tab-${item.id}`} type="button" role="tab" aria-selected={tab === item.id} aria-controls="jobs-panel"
              onClick={() => setTab(item.id)}
              className={cn("-mb-px border-b-2 px-3 py-2 text-sm transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                tab === item.id ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
              {item.label}
            </button>
          ))}
        </div>
        <p className="sr-only" aria-live="polite">
          {tab === "upcoming" ? "Upcoming runs view." : loading ? "Loading jobs." : `${jobs.length} jobs loaded. ${runningCount} running.`}
        </p>

        <div id="jobs-panel" role="tabpanel" aria-labelledby={`jobs-tab-${tab}`} className="pt-4">
          {tab === "upcoming" ? (
            <UpcomingRuns agent={agent} csrfToken={csrfToken} />
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <select aria-label="Agent" value={agent} onChange={(event) => setAgent(event.target.value)}
                  className="h-8 rounded-md border border-input bg-card px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring">
                  <option value="">All agents</option>
                  {agents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
                <select aria-label="Outcome" value={effectiveOutcome} disabled={tab === "failed"}
                  onChange={(event) => setOutcome(event.target.value as JobOutcomeFilter)}
                  className="h-8 rounded-md border border-input bg-card px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60">
                  {OUTCOME_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
                <select aria-label="Date range" value={range} onChange={(event) => setRange(event.target.value as JobRange)}
                  className="h-8 rounded-md border border-input bg-card px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring">
                  {RANGE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
                <div className="relative ml-auto w-full sm:w-64">
                  <Search aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" strokeWidth={1.5} />
                  <input type="search" aria-label="Search runs" placeholder="Search runs…" value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    className="h-8 w-full rounded-md border border-input bg-card pl-8 pr-2 text-sm placeholder:text-text-subtle focus-visible:outline-2 focus-visible:outline-ring" />
                </div>
              </div>
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
                <section aria-labelledby="jobs-list-heading" className="min-w-0 overflow-hidden rounded-lg border border-border bg-card">
                  <h2 id="jobs-list-heading" className="sr-only">Runs</h2>
                  {loading && jobs.length === 0 ? (
                    <div aria-busy="true" className="divide-y divide-border">
                      {[0, 1, 2, 3, 4].map((index) => <div key={index} className="h-10 animate-pulse bg-accent/60" />)}
                      <p role="status" className="p-4 text-sm text-muted-foreground">Loading jobs…</p>
                    </div>
                  ) : jobs.length === 0 && error ? (
                    <div role="alert" className="flex flex-col items-start gap-2 p-6">
                      <p className="text-sm text-danger">Jobs could not be loaded.</p>
                      <button type="button" onClick={() => setReloadKey((value) => value + 1)}
                        className="text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">Try again</button>
                    </div>
                  ) : jobs.length === 0 ? (
                    <div className="flex min-h-48 flex-col items-center justify-center gap-2 px-6 py-12 text-center">
                      <p className="text-sm font-medium">{filtered ? "No jobs match these filters." : "No jobs yet."}</p>
                      <p className="text-sm text-muted-foreground">
                        {filtered ? "Clear the filters to see every run." : "Send an agent a task in chat. Each run appears here with its outcome and cost."}
                      </p>
                      {filtered ? <Button type="button" variant="secondary" size="sm" onClick={clearFilters}>Clear filters</Button>
                        : <Link href="/" className="text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">Open the workspace</Link>}
                    </div>
                  ) : (
                    <>
                      {error ? (
                        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2 text-sm text-danger">
                          <span>Couldn&apos;t refresh jobs. Showing the last loaded list.</span>
                          <button type="button" onClick={() => setReloadKey((value) => value + 1)}
                            className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">Try again</button>
                        </div>
                      ) : null}
                      <JobsTable jobs={jobs} selectedRunId={selectedRunId} timeZone={timeZone} onSelect={setSelectedRunId} />
                    </>
                  )}
                  {nextCursor && !loading && !error ? (
                    <div className="border-t border-border p-3 text-center">
                      <Button type="button" variant="secondary" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
                        {loadingMore ? "Loading…" : "Load more"}
                      </Button>
                    </div>
                  ) : null}
                </section>

                <aside className="flex flex-col gap-4">
                  {selected ? (
                    <JobSummary summary={selected} timeZone={timeZone} csrfToken={csrfToken} showActions={false}
                      onChanged={() => setReloadKey((value) => value + 1)} />
                  ) : (
                    <section aria-labelledby="selected-job-heading" className="rounded-lg border border-border bg-card p-4">
                      <h2 id="selected-job-heading" className="text-sm font-semibold tracking-tight">Selected job</h2>
                      <p className="mt-2 text-sm text-muted-foreground">Select a run to see its summary and cost.</p>
                    </section>
                  )}
                  <section aria-labelledby="crew-actions-heading" className="rounded-lg border border-border bg-card p-4">
                    <h2 id="crew-actions-heading" className="text-sm font-semibold tracking-tight">Crew actions</h2>
                    <p className="mt-1 text-sm text-muted-foreground">Take action on the selected run.</p>
                    <div className="mt-3">
                      {selected ? (
                        <div className="flex flex-col gap-2">
                          <JobActions runId={selected.runId} label={selected.label} outcome={selected.outcome} trigger={selected.trigger}
                            routineId={selected.routineId} csrfToken={csrfToken} onChanged={() => setReloadKey((value) => value + 1)} />
                          {selected.routineId && (selected.trigger === "schedule" || selected.trigger === "run_now") ? (
                            <div className="mt-1 border-t border-border pt-3">
                              <p className="text-xs text-muted-foreground">Run this job&apos;s routine now</p>
                              <RoutineRunNow key={selected.routineId} routineId={selected.routineId} csrfToken={csrfToken}
                                className="mt-1" onStarted={() => setReloadKey((value) => value + 1)} />
                            </div>
                          ) : null}
                        </div>
                      ) : <p className="text-sm text-muted-foreground">Select a job to retry or cancel it.</p>}
                    </div>
                  </section>
                </aside>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
