"use client";
import type { ReactNode } from "react";
import { Monitor } from "lucide-react";
import { LiveRunCard } from "@/components/chat/live-run-card";

// Workspace right column (images 05/39): the single live stream plus current run activity.
// The stream element itself is owned by LiveView and passed in as `desktop`, so exactly one
// instance exists across center tabs, expansion and layout changes.
export function DesktopColumn({ desktop, agentId, agentName, avatarVariant, csrfToken, active }: {
  desktop?: ReactNode;
  agentId?: string;
  agentName?: string;
  avatarVariant?: number;
  csrfToken?: string;
  active: boolean;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <h2 className="text-sm font-semibold tracking-tight">Live Desktop</h2>
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span aria-hidden="true" className={active ? "size-1.5 rounded-full bg-success" : "size-1.5 rounded-full bg-muted-foreground"} />
          {active ? "Live" : "Offline"}
        </span>
      </div>
      <div className="p-4">
        {desktop ?? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-border bg-surface p-6 text-center">
            <Monitor aria-hidden="true" className="size-5 text-muted-foreground" strokeWidth={1.5} />
            <p className="text-sm font-medium">No desktop open</p>
            <p className="text-sm text-muted-foreground">Select an active agent to use its desktop. A stopped desktop can be started from Settings; a paused agent must be resumed first.</p>
          </div>
        )}
      </div>
      {agentId && (
        <section aria-label="Current activity" className="px-4 pb-4">
          <h3 className="mb-2 text-sm font-semibold tracking-tight">Current activity</h3>
          <LiveRunCard agentId={agentId} csrfToken={csrfToken ?? ""} active={active} agentName={agentName} avatarVariant={avatarVariant} layout="full" />
          <p className="text-xs text-muted-foreground">Live steps appear here while a run is executing. Finished runs are listed in History.</p>
        </section>
      )}
    </div>
  );
}
