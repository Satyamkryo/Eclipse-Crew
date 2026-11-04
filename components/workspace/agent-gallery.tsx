"use client";
import { useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { AGENT_TEMPLATES, type AgentTemplate, type AgentTemplateId } from "@/lib/agents/templates";
import { AgentAvatar, randomAvatarVariant } from "@/components/workspace/agent-avatar";
import { StatusChip } from "@/components/ui/status-chip";

// Dispatched by the gallery cards; AppShell opens the same create-agent dialog
// the header button uses, optionally with a template preselected.
export const CREATE_AGENT_EVENT = "eclipse:create-agent";

export function openCreateAgent(templateId?: AgentTemplateId) {
  window.dispatchEvent(new CustomEvent(CREATE_AGENT_EVENT, { detail: templateId ? { templateId } : {} }));
}

export type GalleryAgent = {
  id: string;
  name: string;
  role: string;
  status: "active" | "paused";
  avatarVariant: number;
};

function shuffled<T>(items: readonly T[]): T[] {
  const next = [...items];
  if (next.length < 2 || typeof crypto?.getRandomValues !== "function") return next;
  const rand = new Uint32Array(next.length);
  crypto.getRandomValues(rand);
  for (let i = next.length - 1; i > 0; i--) {
    const j = rand[i] % (i + 1);
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

// The no-agent workspace: owned agents as cards, five random templates, and a
// create card. The picks randomize per render like the form's shuffled avatar.
export function AgentGallery({ agents }: { agents: GalleryAgent[] }) {
  const [templates] = useState<AgentTemplate[]>(() => shuffled(AGENT_TEMPLATES).slice(0, 5));
  const [createAvatar] = useState(() => randomAvatarVariant());

  // No own scroll container: AppShell already scrolls this page, so a second
  // overflow-y-auto here caused a permanent stray scrollbar. The single outer
  // scroller appears only when the agent list outgrows the viewport.
  return (
    <div className="w-full">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-6 sm:px-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Agents</h1>
          <p className="mt-1 text-sm text-muted-foreground">Start from a template, pick up where you left off, or create someone new.</p>
        </div>
        <section aria-labelledby="gallery-templates">
          <h2 id="gallery-templates" className="mb-3 text-base font-semibold tracking-tight">Start from a template</h2>
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {templates.map((template) => (
              <li key={template.id} className="min-w-0">
                <button type="button" onClick={() => openCreateAgent(template.id)} aria-label={`Create a ${template.label} agent`}
                  className="flex h-full w-full flex-col gap-3 rounded-xl border border-border bg-surface p-5 text-left transition-colors duration-150 hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-ring">
                  <span className="flex min-w-0 items-center gap-4">
                    <AgentAvatar seed={template.id} size={48} label={`${template.label} template avatar`} />
                    <span className="min-w-0">
                      <span className="block truncate text-base font-medium">{template.label}</span>
                      <span className="block truncate text-sm text-muted-foreground">{template.role} · ${template.dailyBudgetUsd}/day</span>
                    </span>
                  </span>
                  <span className="text-sm text-muted-foreground">{template.description}</span>
                </button>
              </li>
            ))}
            <li className="min-w-0">
              <button type="button" onClick={() => openCreateAgent()} aria-label="Create a new agent"
                className="flex h-full w-full flex-col gap-3 rounded-xl border border-dashed border-border-strong bg-surface p-5 text-left transition-colors duration-150 hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-ring">
                <span className="flex min-w-0 items-center gap-4">
                  <AgentAvatar seed="create-agent" variant={createAvatar} size={48} label="New agent avatar preview" />
                  <span className="flex min-w-0 items-center gap-1.5 text-base font-medium">
                    <Plus aria-hidden="true" className="size-5 shrink-0" />Create agent
                  </span>
                </span>
                <span className="text-sm text-muted-foreground">A blank canvas — name, role and a shuffled avatar to start.</span>
              </button>
            </li>
          </ul>
        </section>
        {agents.length > 0 && (
          <section aria-labelledby="gallery-mine">
            <h2 id="gallery-mine" className="mb-3 text-base font-semibold tracking-tight">Your agents</h2>
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {agents.map((agent) => (
                <li key={agent.id} className="min-w-0">
                  <Link href={`/?agent=${agent.id}`}
                    className="flex h-full items-center gap-4 rounded-xl border border-border bg-surface p-5 transition-colors duration-150 hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-ring">
                    <AgentAvatar seed={agent.id} variant={agent.avatarVariant} size={48} label={`${agent.name} avatar`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-base font-medium">{agent.name}</span>
                      <span className="block truncate text-sm text-muted-foreground">{agent.role}</span>
                    </span>
                    <StatusChip tone={agent.status === "active" ? "success" : "neutral"} label={agent.status === "active" ? "Running" : "Paused"} />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
