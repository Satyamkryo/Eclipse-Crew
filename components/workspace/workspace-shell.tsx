"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Bot, ListChecks, MessageSquare, PanelRight, UsersRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Layout = "mobile" | "tablet" | "desktop";
type MobileView = "agents" | "chat" | "panel";
type Props = { initialMobileView: MobileView; showAgentPanel: boolean; showAgentError: boolean; agentPane: ReactNode; chatPane: ReactNode; panel: ReactNode };

export function WorkspaceShell({ initialMobileView, showAgentPanel, showAgentError, agentPane, chatPane, panel }: Props) {
  const [layout, setLayout] = useState<Layout | null>(null);
  const [mobileView, setMobileView] = useState<MobileView>(initialMobileView);
  const [panelOpen, setPanelOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(380);
  const [viewportWidth, setViewportWidth] = useState(1440);
  const panelOpener = useRef<HTMLButtonElement>(null);
  const agentsOpener = useRef<HTMLButtonElement>(null);
  const panelWasOpen = useRef(false);
  const agentsWereOpen = useRef(false);
  const styleSheet = useRef<CSSStyleSheet | null>(null);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const maxPanelWidth = Math.max(380, Math.floor(viewportWidth / 2));
  const effectivePanelWidth = Math.min(Math.max(panelWidth, 380), maxPanelWidth);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1280px)");
    const tablet = window.matchMedia("(min-width: 768px)");
    const update = () => {
      const next = desktop.matches ? "desktop" : tablet.matches ? "tablet" : "mobile";
      setLayout(next);
      if (next !== "tablet") { setPanelOpen(false); setAgentsOpen(false); }
      else if (showAgentPanel) setPanelOpen(true);
      else if (showAgentError) setAgentsOpen(true);
    };
    update();
    desktop.addEventListener("change", update);
    tablet.addEventListener("change", update);
    return () => { desktop.removeEventListener("change", update); tablet.removeEventListener("change", update); };
  }, [showAgentPanel, showAgentError]);

  useEffect(() => {
    const update = () => setViewportWidth(window.innerWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(".workspace-panel{width:380px}");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    styleSheet.current = sheet;
    return () => {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((candidate) => candidate !== sheet);
      styleSheet.current = null;
    };
  }, []);

  useEffect(() => {
    styleSheet.current?.replaceSync(`.workspace-panel{width:${effectivePanelWidth}px}`);
  }, [effectivePanelWidth]);

  useEffect(() => {
    if (layout !== "desktop") drag.current = null;
  }, [layout]);

  useEffect(() => {
    if (panelWasOpen.current && !panelOpen) panelOpener.current?.focus();
    panelWasOpen.current = panelOpen;
  }, [panelOpen]);

  useEffect(() => {
    if (agentsWereOpen.current && !agentsOpen) agentsOpener.current?.focus();
    agentsWereOpen.current = agentsOpen;
  }, [agentsOpen]);

  const closePanel = () => setPanelOpen(false);
  const closeAgents = () => setAgentsOpen(false);
  const onSeparatorKeyDown = (event: React.KeyboardEvent) => {
    let next = effectivePanelWidth;
    if (event.key === "ArrowLeft") next += 16;
    else if (event.key === "ArrowRight") next -= 16;
    else if (event.key === "Home") next = 380;
    else if (event.key === "End") next = maxPanelWidth;
    else return;
    event.preventDefault();
    setPanelWidth(Math.min(Math.max(next, 380), maxPanelWidth));
  };
  const onPointerMove = (event: React.PointerEvent) => {
    if (!drag.current) return;
    event.preventDefault();
    const next = drag.current.startWidth + drag.current.startX - event.clientX;
    setPanelWidth(Math.min(Math.max(next, 380), maxPanelWidth));
  };

  if (layout === null) {
    return (
      <main aria-label="Eclipse Crew workspace" aria-busy="true" className="flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground">
        <header className="flex h-12 shrink-0 items-center border-b border-border px-4">
          <h1 className="text-lg font-semibold tracking-tight">Eclipse Crew</h1>
        </header>
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="h-24 w-full max-w-3xl animate-pulse rounded-lg bg-accent" />
          <p className="sr-only">Loading workspace</p>
        </div>
      </main>
    );
  }

  if (layout === "mobile") {
    return (
      <main aria-label="Eclipse Crew workspace" className="flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <h1 className="text-lg font-semibold tracking-tight">Eclipse Crew</h1>
          <Button asChild variant="ghost" size="sm">
            <Link href="/jobs"><ListChecks aria-hidden="true" className="h-4 w-4" />Jobs</Link>
          </Button>
        </header>
        <div className="min-h-0 flex-1">
          {mobileView === "agents" && <aside aria-label="Agents pane" className="h-full">{agentPane}</aside>}
          {mobileView === "chat" && <section aria-label="Chat pane" className="h-full">{chatPane}</section>}
          {mobileView === "panel" && <aside aria-label="Workspace panel" className="h-full">{panel}</aside>}
        </div>
        <MobileNav value={mobileView} onChange={setMobileView} />
      </main>
    );
  }

  if (layout === "tablet") {
    return (
      <main aria-label="Eclipse Crew workspace" className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
        <aside aria-label="Agents rail" className="flex w-14 shrink-0 flex-col items-center border-r border-border">
          <div className="flex h-12 w-full items-center justify-center border-b border-border" aria-hidden="true">
            <span className="text-xs font-semibold tracking-tight">EC</span>
          </div>
          <Button ref={agentsOpener} type="button" variant="ghost" size="sm" className="mt-3" aria-label="Open agents" title="Open agents"
            onClick={() => setAgentsOpen(true)}>
            <Bot aria-hidden="true" className="h-4 w-4" />
          </Button>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
            <h1 className="text-lg font-semibold tracking-tight">Eclipse Crew</h1>
            <div className="flex items-center gap-1">
              <Button asChild variant="ghost" size="sm">
                <Link href="/jobs"><ListChecks aria-hidden="true" className="h-4 w-4" />Jobs</Link>
              </Button>
              <Button ref={panelOpener} type="button" variant="secondary" size="sm" aria-label="Open workspace panel"
                onClick={() => setPanelOpen(true)}>
                <PanelRight aria-hidden="true" className="h-4 w-4" />Panel
              </Button>
            </div>
          </header>
          <section aria-label="Chat pane" className="min-h-0 flex-1">{chatPane}</section>
        </div>
        {panelOpen && <Sheet label="Workspace panel" onClose={closePanel}>{panel}</Sheet>}
        {agentsOpen && <Sheet label="Agents pane" onClose={closeAgents}>{agentPane}</Sheet>}
      </main>
    );
  }

  return (
    <main aria-label="Eclipse Crew workspace" className="flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground">
        <header className="flex h-12 shrink-0 items-center justify-between gap-6 border-b border-border px-4">
          <h1 className="whitespace-nowrap text-lg font-semibold tracking-tight">Eclipse Crew</h1>
          <div className="flex items-center gap-1">
            <Button asChild variant="ghost" size="sm">
              <Link href="/jobs"><ListChecks aria-hidden="true" className="h-4 w-4" />Jobs</Link>
            </Button>
          </div>
        </header>
      <div className="flex min-h-0 flex-1 overflow-hidden">
      <aside aria-label="Agents pane" className="flex w-[260px] shrink-0 flex-col border-r border-border">
        <div className="min-h-0 flex-1">{agentPane}</div>
      </aside>
      <section aria-label="Chat pane" className="min-w-0 flex-1">{chatPane}</section>
      <div role="separator" aria-label="Resize workspace panel" aria-orientation="vertical" tabIndex={0}
        aria-valuemin={380} aria-valuemax={maxPanelWidth} aria-valuenow={effectivePanelWidth} aria-valuetext={`${effectivePanelWidth} pixels`}
        className="relative z-10 w-px shrink-0 cursor-col-resize touch-none bg-border focus-visible:outline-2 focus-visible:outline-ring after:absolute after:inset-y-0 after:-left-3 after:w-6"
        onKeyDown={onSeparatorKeyDown}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          drag.current = { startX: event.clientX, startWidth: effectivePanelWidth };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => {
          drag.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => { drag.current = null; }}
        onLostPointerCapture={() => { drag.current = null; }} />
      <aside aria-label="Workspace panel" className="workspace-panel flex min-h-0 shrink-0 flex-col">
        {panel}
      </aside>
      </div>
    </main>
  );
}

function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);
  const trapFocus = (event: React.KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== "Tab" || !dialog.current) return;
    const focusable = Array.from(dialog.current.querySelectorAll<HTMLElement>(
      "button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex=\"-1\"])",
    )).filter((element) => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const current = document.activeElement;
    if (!dialog.current.contains(current)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && current === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <dialog ref={dialog} aria-label={label} aria-modal="true" onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={trapFocus}
      className="m-0 ml-auto h-dvh max-h-none w-[min(420px,80vw)] max-w-none animate-in border-y-0 border-r-0 border-l border-solid border-border bg-card p-0 text-foreground backdrop:bg-black/70 fade-in slide-in-from-right-5 duration-200">
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
          <h2 className="text-sm font-semibold">{label}</h2>
          <Button type="button" variant="ghost" size="sm" aria-label={`Close ${label.toLowerCase()}`} title={`Close ${label.toLowerCase()}`} onClick={onClose}>
            <X aria-hidden="true" className="h-4 w-4" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </dialog>
  );
}

function MobileNav({ value, onChange }: { value: MobileView; onChange: (value: MobileView) => void }) {
  const items = [
    { id: "agents", label: "Agents", Icon: UsersRound },
    { id: "chat", label: "Chat", Icon: MessageSquare },
    { id: "panel", label: "Panel", Icon: PanelRight },
  ] as const;
  return (
    <nav aria-label="Workspace panes" className="grid h-14 shrink-0 grid-cols-3 border-t border-border bg-card">
      {items.map(({ id, label, Icon }) => (
        <button key={id} type="button" aria-pressed={value === id} onClick={() => onChange(id)}
          className={cn("flex flex-col items-center justify-center gap-1 text-xs transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
            value === id ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
          <Icon aria-hidden="true" className="h-4 w-4" />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
