"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Search, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/workspace/modal-dialog";
import { AgentForm } from "@/components/workspace/agent-form";
import { AppNavList, SearchPalette } from "@/components/workspace/app-navigation";
import { cn } from "@/lib/utils";
import type { AgentSummary } from "@/components/workspace/agent-pane";

export type OwnerChip = { email: string; timezone: string } | null;

type Layout = "mobile" | "tablet" | "desktop";

type Props = {
  owner: OwnerChip;
  /** Sidebar agent list; provided by every authenticated page. */
  agents?: AgentSummary[];
  selectedAgentId?: string;
  /** The workspace's interactive agent section (attention polling, create dialog, toasts). */
  agentsSection?: ReactNode;
  /** Bottom navigation for the workspace's mobile Agents/Chat/Panel views. */
  mobileNav?: ReactNode;
  /** Extra header control (e.g. the workspace Panel button); tablet and desktop headers. */
  headerAction?: ReactNode;
  /** Content label for the tablet/mobile header (e.g. the page title). */
  pageTitle?: string;
  csrfToken?: string;
  children: ReactNode;
};

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "A";
}

// Shared reference shell (docs/DESIGN.md "App shell"): left sidebar with navigation and the
// agent list, a top header with global search and the owner chip, and the page content.
export function AppShell({ owner, agents = [], selectedAgentId, agentsSection, mobileNav, pageTitle, headerAction, csrfToken, children }: Props) {
  const [layout, setLayout] = useState<Layout | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1280px)");
    const tablet = window.matchMedia("(min-width: 768px)");
    const update = () => setLayout(desktop.matches ? "desktop" : tablet.matches ? "tablet" : "mobile");
    update();
    desktop.addEventListener("change", update);
    tablet.addEventListener("change", update);
    return () => { desktop.removeEventListener("change", update); tablet.removeEventListener("change", update); };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && !event.isComposing) {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const newAgentButton = csrfToken && layout !== "mobile" ? (
    <Button type="button" size="sm" onClick={() => setCreating(true)}>
      <Plus aria-hidden="true" className="size-4" />New Agent
    </Button>
  ) : null;

  if (layout === null) {
    return (
      <main aria-label="Eclipse Crew" aria-busy="true" className="flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground">
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="h-24 w-full max-w-3xl animate-pulse rounded-lg bg-accent" />
          <p className="sr-only">Loading</p>
        </div>
      </main>
    );
  }

  if (layout === "mobile") {
    return (
      <main aria-label="Eclipse Crew" className="flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground">
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
          <Link href="/" className="text-lg font-semibold tracking-tight">Eclipse Crew</Link>
          {pageTitle && <span className="min-w-0 truncate text-sm font-medium">{pageTitle}</span>}
          <div className="flex items-center gap-1">
            <Button type="button" variant="ghost" size="sm" aria-label="Search agents" onClick={() => setSearchOpen(true)}>
              <Search aria-hidden="true" className="size-4" />
            </Button>
            <OwnerChipView owner={owner} compact />
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {mobileNav}
        <SearchPalette agents={agents} open={searchOpen} onClose={() => setSearchOpen(false)} />
        {creating && csrfToken && <CreateAgentDialog csrfToken={csrfToken} onClose={() => setCreating(false)} router={router} />}
      </main>
    );
  }

  if (layout === "tablet") {
    return (
      <main aria-label="Eclipse Crew" className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
        <aside aria-label="App rail" className="flex w-14 shrink-0 flex-col items-center border-r border-border">
          <Link href="/" aria-label="Eclipse Crew home" className="flex h-12 w-full items-center justify-center border-b border-border text-sm font-semibold tracking-tight">E</Link>
          <nav aria-label="Agents" className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto py-3">
            {agents.map((agent) => (
              <Link key={agent.id} href={`/?agent=${agent.id}`} aria-current={agent.id === selectedAgentId ? "page" : undefined}
                aria-label={`Open ${agent.name}`}
                title={`${agent.name}${agent.status === "paused" ? " · Paused" : ""}`}
                className={cn("flex size-9 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  agent.id === selectedAgentId ? "border-border-strong bg-surface-hover text-foreground" : "border-border bg-surface text-muted-foreground hover:bg-surface-hover hover:text-foreground",
                  agent.status === "paused" && "text-subtle")}>
                {initials(agent.name)}
              </Link>
            ))}
          </nav>
          <Link href="/settings/account" aria-label="Settings" className="flex h-12 w-full items-center justify-center border-t border-border text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring">
            <Settings aria-hidden="true" className="size-4" strokeWidth={1.5} />
          </Link>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-3">
            {pageTitle ? <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight">{pageTitle}</h1> : <span className="text-lg font-semibold tracking-tight">Eclipse Crew</span>}
            <div className="flex shrink-0 items-center gap-2">
              {headerAction}
              {newAgentButton}
              <Button type="button" variant="ghost" size="sm" aria-label="Search agents" onClick={() => setSearchOpen(true)}>
                <Search aria-hidden="true" className="size-4" />
              </Button>
              <OwnerChipView owner={owner} compact />
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </div>
        <SearchPalette agents={agents} open={searchOpen} onClose={() => setSearchOpen(false)} />
        {creating && csrfToken && <CreateAgentDialog csrfToken={csrfToken} onClose={() => setCreating(false)} router={router} />}
      </main>
    );
  }

  return (
    <main aria-label="Eclipse Crew" className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
      <aside aria-label="App navigation" className="flex w-[260px] shrink-0 flex-col border-r border-border">
        <Link href="/" className="flex h-16 shrink-0 items-center border-b border-border px-5 text-xl font-semibold tracking-tight">Eclipse Crew</Link>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="py-3">
            <AppNavList />
          </div>
          <div className="border-t border-border px-4 pb-2 pt-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Agents</p>
          </div>
          <div className="min-h-0 flex-1">{agentsSection ?? <StaticAgentList agents={agents} selectedAgentId={selectedAgentId} />}</div>
        </div>
        <p className="flex h-12 shrink-0 items-center gap-2 border-t border-border px-5 text-xs text-muted-foreground">
          Self-hosted · Secure workspace
        </p>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between gap-6 border-b border-border px-6">
          <button type="button" onClick={() => setSearchOpen(true)} aria-label="Search agents (Control K)"
            className="flex h-10 w-full max-w-md items-center gap-3 rounded-md border border-input bg-surface px-3 text-sm text-muted-foreground transition-colors duration-150 hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-ring">
            <Search aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.5} />
            <span className="min-w-0 flex-1 text-left">Search agents, runs…</span>
            <kbd className="shrink-0 rounded border border-border bg-surface-raised px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">Ctrl K</kbd>
          </button>
          <div className="flex shrink-0 items-center gap-3">
            {headerAction}
            {newAgentButton}
            <OwnerChipView owner={owner} />
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
      <SearchPalette agents={agents} open={searchOpen} onClose={() => setSearchOpen(false)} />
      {creating && csrfToken && <CreateAgentDialog csrfToken={csrfToken} onClose={() => setCreating(false)} router={router} />}
    </main>
  );
}

function OwnerChipView({ owner, compact = false }: { owner: OwnerChip; compact?: boolean }) {
  if (!owner) return null;
  const initial = owner.email[0]?.toUpperCase() ?? "A";
  return (
    <span className="flex min-w-0 items-center gap-2" title={compact ? `${owner.email} · ${owner.timezone}` : undefined}>
      <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-xs font-semibold">{initial}</span>
      {!compact && (
        <span className="hidden min-w-0 flex-col lg:flex">
          <span className="min-w-0 truncate text-xs font-medium">{owner.email}</span>
          <span className="truncate text-xs text-muted-foreground">{owner.timezone}</span>
        </span>
      )}
    </span>
  );
}

function StaticAgentList({ agents, selectedAgentId }: { agents: AgentSummary[]; selectedAgentId?: string }) {
  if (agents.length === 0) {
    return <p className="px-4 py-3 text-xs text-muted-foreground">No agents yet. Create one from the workspace.</p>;
  }
  return (
    <ul aria-label="Agents" className="flex flex-col gap-0.5 px-2">
      {agents.map((agent) => (
        <li key={agent.id}>
          <Link href={`/?agent=${agent.id}`} aria-current={agent.id === selectedAgentId ? "page" : undefined}
            className={cn("flex min-w-0 items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
              agent.id === selectedAgentId ? "bg-surface-hover text-foreground" : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
              agent.status === "paused" && "text-subtle")}>
            <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border text-[10px] font-semibold">{initials(agent.name)}</span>
            <span className="min-w-0 flex-1 truncate">{agent.name}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function CreateAgentDialog({ csrfToken, onClose, router }: { csrfToken: string; onClose: () => void; router: ReturnType<typeof useRouter> }) {
  return (
    <ModalDialog title="Create agent" description="The agent gets its own Linux user, desktop and Chromium profile." onClose={onClose}>
      <AgentForm mode="create" csrfToken={csrfToken}
        onSaved={(agentId) => {
          onClose();
          if (agentId) router.push(`/?agent=${agentId}`);
          router.refresh();
        }}
        onCancel={onClose} />
    </ModalDialog>
  );
}
