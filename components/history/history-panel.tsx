"use client";
import { useState } from "react";
import { ReplaySection } from "./replay-section";
import { RunList } from "./run-list";
import { RunTimeline } from "./run-timeline";

// The History tab: this agent's saved replays and runs, and one run's step timeline. Rewind comes with TASK-043.
export function HistoryPanel({ agentId, timeZone, csrfToken }: { agentId?: string; timeZone: string; csrfToken: string }) {
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
      <RunTimeline runId={openRun.runId} timeZone={timeZone} csrfToken={csrfToken} onBack={() => setOpenRun(null)}
        onOpenRun={(runId) => setOpenRun({ agentId, runId })} />
    );
  }
  return (
    <div className="flex flex-col">
      <ReplaySection agentId={agentId} csrfToken={csrfToken} timeZone={timeZone} />
      <RunList agentId={agentId} timeZone={timeZone} onOpen={(runId) => setOpenRun({ agentId, runId })} />
    </div>
  );
}
