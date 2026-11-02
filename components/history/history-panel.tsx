"use client";
import { useState } from "react";
import { AstraBadge } from "@/components/ui/astra-badge";
import { ReplaySection } from "./replay-section";
import { RunList } from "./run-list";
import { RunTimeline } from "./run-timeline";

// The History tab: this agent's saved replays and runs, and one run's step timeline. Rewind comes with TASK-043.
export function HistoryPanel({ agentId, agentName, astraMode, timeZone, csrfToken }: {
  agentId?: string; agentName?: string; astraMode?: boolean; timeZone: string; csrfToken: string;
}) {
  const [openRun, setOpenRun] = useState<{ agentId: string; runId: string } | null>(null);
  if (!agentId) {
    return (
      <div className="flex h-full min-h-48 flex-col items-center justify-center gap-1 px-6 py-12 text-center">
        <p className="text-sm font-medium">History</p>
        <p className="text-sm text-muted-foreground">Select an agent to see its runs.</p>
      </div>
    );
  }
  // A run belongs to one agent: switching agents never shows another agent's open run.
  if (openRun && openRun.agentId === agentId) {
    return (
      <>
        <HistoryAgentHeader agentName={agentName} astraMode={astraMode} />
        <RunTimeline runId={openRun.runId} timeZone={timeZone} csrfToken={csrfToken} onBack={() => setOpenRun(null)}
          onOpenRun={(runId) => setOpenRun({ agentId, runId })} />
      </>
    );
  }
  return (
    <div className="flex flex-col">
      <HistoryAgentHeader agentName={agentName} astraMode={astraMode} />
      <ReplaySection agentId={agentId} csrfToken={csrfToken} timeZone={timeZone} />
      <RunList agentId={agentId} timeZone={timeZone} onOpen={(runId) => setOpenRun({ agentId, runId })} />
    </div>
  );
}

// TASK-051. The History tab belongs to one agent; show whose history it is and whether Astra Mode is on.
function HistoryAgentHeader({ agentName, astraMode }: { agentName?: string; astraMode?: boolean }) {
  if (!agentName) return null;
  return (
    <div className="flex min-w-0 items-center gap-1.5 border-b border-border px-4 py-3">
      <span className="min-w-0 truncate text-sm font-semibold">{agentName}</span>
      {astraMode && <AstraBadge />}
    </div>
  );
}
