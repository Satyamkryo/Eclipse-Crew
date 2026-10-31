"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentForm } from "@/components/workspace/agent-form";
import { ModalDialog } from "@/components/workspace/modal-dialog";
import { cn } from "@/lib/utils";

export type AgentSummary = { id: string; name: string; role: string; status: "active" | "paused" };

type Props = { agents: AgentSummary[]; selectedAgentId?: string; error?: string; csrfToken: string };

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "A";
}

export function AgentPane({ agents, selectedAgentId, error, csrfToken }: Props) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <h2 className="text-lg font-semibold tracking-tight">Agents</h2>
        <Button type="button" size="sm" onClick={() => setCreating(true)}>
          <Plus aria-hidden="true" className="size-4" />Create agent
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error && <p role="alert" className="mb-3 rounded-md border border-danger px-3 py-2 text-sm text-danger">{error}</p>}
        {agents.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <span className="flex size-9 items-center justify-center rounded-full border border-border" aria-hidden="true">
              <Bot className="size-4" />
            </span>
            <div>
              <p className="text-sm font-medium">No agents yet.</p>
              <p className="mt-1 text-sm text-muted-foreground">Create an agent to give it an isolated desktop, browser and files.</p>
            </div>
            <Button type="button" size="sm" onClick={() => setCreating(true)}>Create agent</Button>
          </div>
        ) : (
          <ul aria-label="Agents" className="flex flex-col gap-1">
            {agents.map((agent) => {
              const selected = agent.id === selectedAgentId;
              return (
                <li key={agent.id}>
                  <Link href={`/?agent=${agent.id}`} aria-current={selected ? "page" : undefined}
                    className={cn("flex min-w-0 items-center gap-3 rounded-md border border-transparent px-2 py-2 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
                      selected ? "border-border-strong bg-surface-hover" : "hover:bg-surface-hover")}>
                    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full border border-border text-xs font-semibold",
                      agent.status === "paused" && "text-subtle")} aria-hidden="true">
                      {initials(agent.name)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate text-sm font-medium", agent.status === "paused" && "text-subtle")}>{agent.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{agent.role}</span>
                    </span>
                    {agent.status === "paused" && <span className="text-xs text-muted-foreground">Paused</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {creating && (
        <ModalDialog title="Create agent" description="The agent gets its own Linux user, desktop and Chromium profile."
          onClose={() => setCreating(false)}>
          <AgentForm mode="create" csrfToken={csrfToken}
            onSaved={(agentId) => {
              setCreating(false);
              if (agentId) router.push(`/?agent=${agentId}`);
              router.refresh();
            }}
            onCancel={() => setCreating(false)} />
        </ModalDialog>
      )}
    </div>
  );
}
