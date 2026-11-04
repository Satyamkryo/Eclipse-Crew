"use client";
import { useRef, useState } from "react";
import Link from "next/link";
import { AstraBadge } from "@/components/ui/astra-badge";
import { AgentAvatar } from "@/components/workspace/agent-avatar";
import { AgentGallery } from "@/components/workspace/agent-gallery";
import { StatusChip } from "@/components/ui/status-chip";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export type WorkspaceTabId = "chat" | "settings" | "tools" | "routines" | "history" | "memory";
const TABS = [
  { id: "chat", label: "Chat" },
  { id: "settings", label: "Settings" },
  { id: "tools", label: "Tools" },
  { id: "routines", label: "Routines" },
  { id: "history", label: "History" },
  { id: "memory", label: "Memory" },
] as const;

export type CenterAgent = { id: string; name: string; role: string; status: "active" | "paused"; astraMode: boolean; avatarVariant: number };

// Agent heading + central tabs (images 05/36/39): the tabs that used to live on the right
// panel are now the center column's navigation, under the agent identity.
export function WorkspaceCenter({ agent, agents, initialTab, children }: {
  agent?: CenterAgent;
  agents?: CenterAgent[];
  initialTab?: WorkspaceTabId;
  children: (tab: WorkspaceTabId) => ReactNode;
}) {
  const [active, setActive] = useState<WorkspaceTabId>(initialTab ?? "chat");
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  // No agent selected: the gallery (owned agents, five random templates, the
  // create card). The right desktop panel stays hidden until an agent is open.
  if (!agent) {
    return <AgentGallery agents={agents ?? []} />;
  }

  const select = (index: number, focus: boolean) => {
    setActive(TABS[index].id);
    if (focus) buttons.current[index]?.focus();
  };
  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    let next: number | undefined;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    select(next, true);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-6 pb-3 pt-4">
        <div className="flex min-w-0 items-start gap-3">
          <AgentAvatar seed={agent.id} variant={agent.avatarVariant} size={40} label={`${agent.name} avatar`} />
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight">{agent.name}</h1>
              {agent.astraMode && <AstraBadge />}
            </div>
            <div className="mt-1 flex items-center gap-2">
              <span className="min-w-0 truncate text-sm text-muted-foreground">{agent.role}</span>
              <StatusChip tone={agent.status === "active" ? "success" : "neutral"} label={agent.status === "active" ? "Running" : "Paused"} />
            </div>
          </div>
        </div>
      </div>
      {/* Phones use the right panel's proven six-column grid so every tab fits at 375 px; wider screens keep the spaced row. */}
      <div role="tablist" aria-label={`${agent.name} workspace`} className="grid shrink-0 grid-cols-6 items-center border-b border-border px-2 sm:flex sm:gap-1 sm:overflow-x-auto sm:px-6">
        {TABS.map((tab, index) => (
          <button key={tab.id} ref={(element) => { buttons.current[index] = element; }} type="button"
            role="tab" id={`center-tab-${tab.id}`} aria-controls="center-tab-content"
            aria-selected={active === tab.id} tabIndex={active === tab.id ? 0 : -1}
            onClick={() => select(index, false)} onKeyDown={(event) => onKeyDown(event, index)}
            className={cn("h-11 min-w-0 border-b-2 px-1 text-xs transition-colors sm:shrink-0 sm:px-3 sm:text-sm duration-150 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
              active === tab.id ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {tab.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="center-tab-content" aria-labelledby={`center-tab-${active}`} tabIndex={0}
        className="min-h-0 flex-1 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring">
        {children(active)}
      </div>
    </div>
  );
}

// Tools and Routines have no dedicated per-agent backend surface in v1; they render honest
// empty states that open the existing pages instead of inventing data (docs/UI_REFERENCE_MAP.md).
export function ToolsTabEmpty() {
  return (
    <EmptyTab title="No tools are connected for this agent yet."
      body="Tool connections are managed for the whole crew. Connect an MCP server, then grant it to agents there."
      href="/settings/connections" label="Open Connections" />
  );
}

export function RoutinesTabEmpty() {
  return (
    <EmptyTab title="No routines for this agent yet."
      body="Ask the agent in chat to create a routine, and confirm it there. Scheduled and upcoming runs live on Schedules."
      href="/schedules" label="Open Schedules" />
  );
}

function EmptyTab({ title, body, href, label }: { title: string; body: string; href: string; label: string }) {
  return (
    <div className="flex h-full min-h-48 items-center justify-center overflow-y-auto p-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{body}</p>
        <Link href={href} className="inline-flex h-8 items-center rounded-md border border-border-strong bg-surface px-3 text-xs font-medium transition-colors duration-150 hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-ring">
          {label}
        </Link>
      </div>
    </div>
  );
}
