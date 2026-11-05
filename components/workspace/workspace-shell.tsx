"use client";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Loader2, PanelRight, UsersRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppShell, type OwnerChip } from "@/components/workspace/app-shell";
import { RoutinesTabEmpty, ToolsTabEmpty, WorkspaceCenter, type CenterAgent, type WorkspaceTabId } from "@/components/workspace/workspace-center";
import { DesktopColumn } from "@/components/workspace/desktop-column";
import { cn } from "@/lib/utils";
import { MobileDock } from "@/components/workspace/mobile-dock";
import type { AgentSummary } from "@/components/workspace/agent-pane";

type MobileView = "agents" | "chat" | "panel";
type Props = {
  initialMobileView: MobileView;
  initialTab?: WorkspaceTabId;
  agents: AgentSummary[];
  selectedAgent?: CenterAgent | null;
  owner: OwnerChip;
  csrfToken: string;
  agentPane: ReactNode;
  chatPane: ReactNode;
  settings?: ReactNode;
  desktop?: ReactNode;
  history: ReactNode;
  memory: ReactNode;
  tools?: ReactNode;
  routines?: ReactNode;
};

// The workspace composes the shared reference shell: sidebar + header from AppShell, the
// agent heading with central tabs in the center, and the live desktop + activity column on
// the right (docs/DESIGN.md "App shell"; images 05, 39, 40).
function subscribeViewport(onChange: () => void) {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}
const readViewport = () => window.innerWidth;
const readNoViewport = () => null;

export function WorkspaceShell({ initialMobileView, initialTab, agents, selectedAgent, owner, csrfToken, agentPane, chatPane, settings, desktop, history, memory, tools, routines }: Props) {
  const [mobileView, setMobileView] = useState<MobileView>(initialMobileView);
  const [panelOpen, setPanelOpen] = useState(false);
  const [agentsSheetOpen, setAgentsSheetOpen] = useState(initialMobileView === "agents");
  const [panelWidth, setPanelWidth] = useState(400);
  // The server and hydration render have no width (laid out as 1440 px); the live view waits for the real width so its
  // stream opens once, in the final layout, instead of opening in a guessed layout and reconnecting.
  const measuredWidth = useSyncExternalStore(subscribeViewport, readViewport, readNoViewport);
  const viewportWidth = measuredWidth ?? 1440;
  const measured = measuredWidth !== null;
  const panelOpener = useRef<HTMLButtonElement>(null);
  const panelWasOpen = useRef(false);
  const agentsOpener = useRef<HTMLButtonElement>(null);
  const agentsWasOpen = useRef(false);
  const styleSheet = useRef<CSSStyleSheet | null>(null);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const maxPanelWidth = Math.max(380, Math.floor(viewportWidth / 2));
  const effectivePanelWidth = Math.min(Math.max(panelWidth, 380), maxPanelWidth);
  const isMobile = viewportWidth < 768;
  const isDesktop = viewportWidth >= 1280;


  useEffect(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(".workspace-panel{width:400px}");
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
    if (panelWasOpen.current && !panelOpen) panelOpener.current?.focus();
    panelWasOpen.current = panelOpen;
  }, [panelOpen]);

  useEffect(() => {
    if (agentsWasOpen.current && !agentsSheetOpen) agentsOpener.current?.focus();
    agentsWasOpen.current = agentsSheetOpen;
  }, [agentsSheetOpen]);

  const closePanel = () => setPanelOpen(false);
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

  const center = (
    <WorkspaceCenter agent={selectedAgent ?? undefined} agents={agents} initialTab={initialTab}>
      {(tab) => (
        <>
          {tab === "chat" && chatPane}
          {tab === "settings" && <div className="h-full min-h-0 overflow-y-auto p-6">{settings ?? <SettingsEmpty />}</div>}
          {tab === "history" && <div className="h-full min-h-0 overflow-y-auto">{history}</div>}
          {tab === "memory" && <div className="h-full min-h-0 overflow-y-auto">{memory}</div>}
          {tab === "tools" && (tools ?? <ToolsTabEmpty />)}
          {tab === "routines" && (routines ? <div className="h-full min-h-0 overflow-y-auto">{routines}</div> : <RoutinesTabEmpty />)}
        </>
      )}
    </WorkspaceCenter>
  );

  const pendingDesktop = desktop && (
    <div className="relative aspect-[4/3] w-full bg-background">
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">Connecting to agent desktop…</p>
      </div>
    </div>
  );
  const column = <DesktopColumn desktop={measured ? desktop : pendingDesktop} agentId={selectedAgent?.id} agentName={selectedAgent?.name} avatarVariant={selectedAgent?.avatarVariant} csrfToken={csrfToken} active={selectedAgent?.status === "active"} />;

  return (
    <AppShell owner={owner} agents={agents} selectedAgentId={selectedAgent?.id} agentsSection={agentPane}
      mobileNav={<MobileDock active={mobileView} onSelect={setMobileView} />}
      headerAction={isDesktop ? undefined : (
        <div className="flex items-center gap-2">
          {!isMobile && <Button ref={agentsOpener} type="button" variant="secondary" size="sm" aria-label="Open agents"
            onClick={() => setAgentsSheetOpen(true)}><UsersRound aria-hidden="true" className="size-4" />Agents</Button>}
          {selectedAgent && (
          <Button ref={panelOpener} type="button" variant="secondary" size="sm" aria-label="Open workspace panel"
            onClick={() => setPanelOpen(true)}><PanelRight aria-hidden="true" className="size-4" />Panel</Button>
          )}
        </div>
      )}
      pageTitle="Workspace"
      csrfToken={csrfToken}>
      {isMobile && mobileView === "agents" && <aside aria-label="Agents pane" className="h-full">{agentPane}</aside>}
      {isMobile && mobileView === "chat" && <section aria-label="Chat pane" className="h-full">{center}</section>}
      {isMobile && mobileView === "panel" && <aside aria-label="Workspace panel" className="h-full">{column}</aside>}
      {!isDesktop && panelOpen && <Sheet label="Workspace panel" onClose={closePanel}>{column}</Sheet>}
      {!isMobile && !isDesktop && agentsSheetOpen && <Sheet label="Agents" onClose={() => setAgentsSheetOpen(false)}>{agentPane}</Sheet>}
      {!isMobile && isDesktop && selectedAgent && (
      <div className="h-full">
        <div className="flex h-full min-h-0">
          <section aria-label="Agent workspace" className="min-w-0 flex-1">{center}</section>
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
            {column}
          </aside>
        </div>
      </div>
      )}
      {!isMobile && isDesktop && !selectedAgent && (
      <section aria-label="Agent workspace" className="h-full min-w-0">{center}</section>
      )}
      {!isMobile && !isDesktop && (
      <div aria-hidden={panelOpen} className={cn("h-full", panelOpen && "hidden")}>
        <section aria-label="Agent workspace" className="h-full min-w-0">{center}</section>
      </div>
      )}
    </AppShell>
  );
}

function SettingsEmpty() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-lg font-semibold tracking-tight">Settings</h3>
        <p className="mt-1 text-sm text-muted-foreground">Select an agent to edit its persona, permissions and budget, or manage models and your owner account.</p>
      </div>
      <div className="flex flex-wrap gap-4">
        <a href="/settings/models" className="text-sm underline underline-offset-4">Model settings</a>
        <a href="/settings/integrations" className="text-sm underline underline-offset-4">Integrations</a>
        <a href="/profile" className="text-sm underline underline-offset-4">Profile</a>
      </div>
    </div>
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
            <X aria-hidden="true" className="size-4" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </dialog>
  );
}
