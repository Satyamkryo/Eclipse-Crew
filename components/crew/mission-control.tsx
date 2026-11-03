"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Activity, CircleAlert, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CrewAgentStatus, CrewStatusView } from "@/lib/crew/status";
import { DesktopThumbnail } from "./desktop-thumbnail";

const POLL_MS = 2000;
const MAX_STREAMS = 4;

export function MissionControl({ initial }: { initial: CrewStatusView | null }) {
  const [data, setData] = useState(initial);
  const [error, setError] = useState(initial === null);
  const [loading, setLoading] = useState(initial === null);
  const inFlight = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => { if (timer) clearTimeout(timer); timer = undefined; };
    const load = async () => {
      if (!alive.current || document.visibilityState !== "visible") return;
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const response = await fetch("/api/crew/status", { cache: "no-store" });
        if (!response.ok) throw new Error();
        const next = await response.json() as CrewStatusView;
        if (!alive.current) return;
        setData(next);
        setError(false);
      } catch {
        if (alive.current) setError(true);
      } finally {
        inFlight.current = false;
        setLoading(false);
        if (alive.current && document.visibilityState === "visible") timer = setTimeout(() => { void load(); }, POLL_MS);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") { clear(); void load(); }
      else clear();
    };
    document.addEventListener("visibilitychange", onVisibility);
    if (document.visibilityState === "visible") void load();
    return () => {
      alive.current = false;
      clear();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const agents = data?.agents ?? [];
  const streamIds = new Set(
    agents.filter((agent) => agent.desktop === "running" && agent.streamGeneration).slice(0, MAX_STREAMS).map((agent) => agent.id),
  );

  return (
    <section aria-labelledby="mission-control-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="mission-control-heading" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Activity aria-hidden="true" className="size-4 text-muted-foreground" />Mission Control
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Live status, current step and spend for this owner only. Frames are view-only.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {data && (
            <>
              <span>Today: <span className="tabular-nums text-foreground">{usd(data.totals.todayCostMicroUsd)}</span></span>
              <span>Running: <span className="tabular-nums text-foreground">{data.totals.running}</span></span>
              <span>Needs you: <span className="tabular-nums text-foreground">{data.totals.needsYou}</span></span>
              <span>{data.timezone}</span>
            </>
          )}
          <Button type="button" variant="secondary" size="sm" disabled={loading} onClick={() => window.location.reload()}>
            <RefreshCw aria-hidden="true" className={cn("size-3.5", loading && "animate-spin")} />Refresh
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="flex items-center gap-2 rounded-md border border-corona px-3 py-2 text-sm text-corona">
          <CircleAlert aria-hidden="true" className="size-4" />
          Status is temporarily unavailable. The last good view stays on screen.
        </p>
      )}
      {loading && !data && <div className="h-40 animate-pulse rounded-lg bg-accent" aria-label="Loading crew status" />}

      {!loading && agents.length === 0 && (
        <div className="rounded-lg border border-border bg-card p-6 text-center">
          <p className="text-sm font-medium">No agents yet.</p>
          <p className="mt-1 text-sm text-muted-foreground">Create the starter crew below to add six roles with their own desktops and policies.</p>
        </div>
      )}

      <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} streaming={streamIds.has(agent.id)} />
        ))}
      </ul>
    </section>
  );
}

function AgentCard({ agent, streaming }: { agent: CrewAgentStatus; streaming: boolean }) {
  const needsYou = agent.attention !== null || agent.pendingApprovals > 0;
  return (
    <li className={cn("flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card", needsYou ? "border-corona" : "border-border")}>
      <div className="p-3">
        {streaming ? (
          <DesktopThumbnail agentId={agent.id} agentName={agent.name} />
        ) : (
          <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-1 rounded-md border border-border bg-black text-center text-xs text-muted-foreground">
            <span>{agent.desktop === "running" ? "Stream paused (offscreen or 4-stream limit)" : agent.desktop === "unavailable" ? "Desktop unavailable" : "Desktop stopped"}</span>
            <span className="text-[11px]">No cached frame is shown as live.</span>
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3 pt-0">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <Link href={`/?agent=${agent.id}`} className="block truncate text-sm font-semibold underline-offset-4 hover:underline">
              {agent.name}
            </Link>
            <p className="truncate text-xs text-muted-foreground">{agent.role}</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1">
            {agent.status === "paused" && <Tag tone="muted">Paused</Tag>}
            {needsYou && <Tag tone="corona">Needs you</Tag>}
            {agent.astraMode && <Tag tone="muted">Astra</Tag>}
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-2 text-xs">
          <div className="col-span-2 min-w-0">
            <dt className="text-muted-foreground">Current</dt>
            <dd className="break-words">
              {agent.currentRun
                ? <>{agent.currentRun.outcomeLabel} · step {agent.currentRun.stepCount} · <span className="text-muted-foreground">{agent.currentRun.label}</span></>
                : <span className="text-muted-foreground">No live run</span>}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Today</dt>
            <dd className="tabular-nums">{usd(agent.todayCostMicroUsd)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">This run</dt>
            <dd className="tabular-nums">{agent.currentRun ? usd(agent.currentRun.costMicroUsd) : "—"}</dd>
          </div>
          <div className="col-span-2 min-w-0">
            <dt className="text-muted-foreground">Model</dt>
            <dd className="truncate font-mono text-[11px]">{agent.model ?? "Not set"}</dd>
          </div>
          {agent.pendingApprovals > 0 && (
            <div className="col-span-2">
              <dt className="text-muted-foreground">Approvals</dt>
              <dd className="tabular-nums">{agent.pendingApprovals} waiting</dd>
            </div>
          )}
        </dl>
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">
          <span className="text-xs text-muted-foreground">
            {agent.attention === "budget_paused" || agent.attention === "budget_warning" ? "Budget alert"
              : agent.attention === "security_stop" ? "Security stop"
              : agent.attention === "teach_paused" ? "Recording paused"
              : agent.attention === "approval_pending" ? "Approval pending" : ""}
          </span>
          <Link href={`/?agent=${agent.id}`} className="text-xs underline underline-offset-4">Open workspace</Link>
        </div>
      </div>
    </li>
  );
}

function Tag({ tone, children }: { tone: "muted" | "corona"; children: React.ReactNode }) {
  return (
    <span className={cn("rounded-md px-1.5 py-0.5 text-[11px]",
      tone === "corona" ? "bg-corona/12 text-corona" : "bg-muted text-muted-foreground")}>
      {children}
    </span>
  );
}

function usd(microUsd: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 })
    .format(microUsd / 1_000_000);
}
