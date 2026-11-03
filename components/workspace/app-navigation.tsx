"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bot, FileText, ListChecks, Plug, Search, Settings, Settings2, UserRound, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentSummary } from "@/components/workspace/agent-pane";

// App navigation per images 02/39, plus the post-reference Crew page kept in the same row
// pattern. Only existing destinations appear here; the reference's Skills and Schedules
// entries have no v1 backend (docs/UI_REFERENCE_MAP.md "Named gaps"), so no dead links are rendered.
export const APP_NAV_ITEMS = [
  { href: "/", label: "Agents", Icon: UserRound, match: (path: string) => path === "/" },
  { href: "/crew", label: "Crew", Icon: Bot, match: (path: string) => path.startsWith("/crew") },
  { href: "/jobs", label: "Jobs", Icon: ListChecks, match: (path: string) => path.startsWith("/jobs") },
  { href: "/?panel=history", label: "Evidence", Icon: FileText, match: () => false },
  { href: "/settings/models", label: "Models", Icon: Settings2, match: (path: string) => path.startsWith("/settings/models") },
  { href: "/settings/connections", label: "MCP Servers", Icon: Plug, match: (path: string) => path.startsWith("/settings/connections") },
  { href: "/settings/account", label: "Settings", Icon: Settings, match: (path: string) => path.startsWith("/settings/account") },
] as const;

export function AppNavList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="App" className="flex flex-col gap-0.5 px-2">
      {APP_NAV_ITEMS.map(({ href, label, Icon, match }) => {
        const active = pathname === "/" ? match("/") : pathname === href || match(pathname);
        return (
          <Link key={label} href={href} onClick={onNavigate} aria-current={active ? "page" : undefined}
            className={cn("flex h-9 items-center gap-3 rounded-md px-3 text-sm transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
              active ? "bg-surface-hover font-medium text-foreground" : "text-muted-foreground hover:bg-surface-hover hover:text-foreground")}>
            <Icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.5} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

type SearchPaletteProps = {
  agents: AgentSummary[];
  open: boolean;
  onClose: () => void;
};

// Global search per reference images 02/39. Its supported scope is named in the UI:
// agent names here, plus links into the existing run search (/jobs) and security-event search (/security).
export function SearchPalette({ agents, open, onClose }: SearchPaletteProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) { setQuery(""); element.showModal(); inputRef.current?.focus(); }
    if (!open && element.open) element.close();
  }, [open]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents.slice(0, 6);
    return agents.filter((agent) => agent.name.toLowerCase().includes(q) || agent.role.toLowerCase().includes(q)).slice(0, 6);
  }, [agents, query]);

  return (
    <dialog ref={dialog} aria-label="Search Eclipse Crew" onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}
      className="m-0 h-dvh max-h-none w-full max-w-none border-0 bg-background/95 p-0 text-foreground backdrop:bg-black/70 md:m-auto md:h-auto md:max-h-[70vh] md:w-[min(560px,92vw)] md:rounded-xl md:border md:border-border md:shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
      <div className="flex min-h-0 flex-col p-4">
        <div className="flex items-center gap-3 rounded-md border border-input bg-surface px-3">
          <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
          <input ref={inputRef} type="text" value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="Search agents…" aria-label="Search agents by name"
            className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-text-subtle" />
          <button type="button" onClick={onClose} aria-label="Close search"
            className="rounded-md p-1 text-muted-foreground hover:bg-surface-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
        <p className="mt-2 px-1 text-xs text-muted-foreground">Searches your agents by name. Run search lives on Jobs; security-event search lives on Security.</p>
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
          {matches.length > 0 ? (
            <ul aria-label="Agent results" className="flex flex-col gap-0.5">
              {matches.map((agent) => (
                <li key={agent.id}>
                  <Link href={`/?agent=${agent.id}`} onClick={onClose}
                    className="flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring">
                    <Bot aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                    <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{agent.role}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-2 py-4 text-center text-sm text-muted-foreground">No agents match “{query}”.</p>
          )}
          <div className="mt-2 flex flex-wrap gap-2 border-t border-border pt-3">
            <Link href="/jobs" onClick={onClose} className="rounded-md border border-border-strong bg-surface px-3 py-1.5 text-xs transition-colors duration-150 hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-ring">
              Search runs on Jobs
            </Link>
            <Link href="/security" onClick={onClose} className="rounded-md border border-border-strong bg-surface px-3 py-1.5 text-xs transition-colors duration-150 hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-ring">
              Search security events
            </Link>
          </div>
        </div>
      </div>
    </dialog>
  );
}
