"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, FileText, Hand, Loader2, Minimize2, Monitor, ShieldCheck, Timer, Cuboid } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AstraBadge } from "@/components/ui/astra-badge";

type TakeoverCheck = {
  available: boolean;
  eligible: boolean;
  onPointerDown: (event: React.PointerEvent) => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
  onRequest: () => void;
};

type Props = {
  agentName: string;
  astraMode: boolean;
  status: "connecting" | "live" | "error";
  takenOver: boolean;
  busy: boolean;
  // The shared keyboard+mouse input check from LiveView (same state inline and expanded).
  takeover: TakeoverCheck;
  modelName?: string;
  // Epoch ms when the stream became live, or null.
  connectedAt: number | null;
  error: string | null;
  // Callback ref for the element that receives the live stream.
  slotRef: (element: HTMLDivElement | null) => void;
  // Takeover input layer and connecting/offline overlay, built by LiveView so the inline and expanded views behave the same.
  overlay: ReactNode;
  teachControls?: ReactNode;
  // Forwards keys to the desktop during a takeover (the same handler the inline view uses).
  onScreenKeyDown: (event: React.KeyboardEvent) => void;
  onHandBack: () => void;
  onExit: () => void;
};

const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex=\"-1\"])";
const pad = (value: number) => String(value).padStart(2, "0");
const clockText = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
function elapsedText(from: number | null, now: number) {
  if (from === null) return "--:--:--";
  const seconds = Math.max(0, Math.floor((now - from) / 1000));
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}
function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "A";
}

// The expanded desktop view (docs/DESIGN.md). It fills the app window, never uses the browser Fullscreen API, and holds
// the same stream element as the inline view, so nothing reconnects and a takeover stays active.
export function ExpandedView({ agentName, astraMode, status, takenOver, busy, takeover, modelName, connectedAt, error, slotRef, overlay, teachControls, onScreenKeyDown, onHandBack, onExit }: Props) {
  const layer = useRef<HTMLDivElement>(null);
  const exitButton = useRef<HTMLButtonElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const statusLabel = status === "live" ? "Live" : status === "connecting" ? "Connecting…" : "Offline";

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // The workspace behind stays visible to nobody: no focus, no clicks, hidden from assistive tech while this is open.
  useEffect(() => {
    const background = document.querySelector<HTMLElement>("main[aria-label=\"Eclipse Crew\"]");
    if (background) background.inert = true;
    exitButton.current?.focus();
    return () => { if (background) background.inert = false; };
  }, []);

  const trapFocus = (event: React.KeyboardEvent) => {
    if (event.key !== "Tab" || !layer.current) return;
    const focusable = Array.from(layer.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const current = document.activeElement;
    if (!layer.current.contains(current)) { event.preventDefault(); first.focus(); }
    else if (event.shiftKey && current === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && current === last) { event.preventDefault(); first.focus(); }
  };

  const controlButton = status === "live" && (takenOver ? (
    <Button size="sm" variant="primary" disabled={busy} onClick={onHandBack}>
      {busy ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <Hand aria-hidden="true" className="size-4" />}
      Hand back
    </Button>
  ) : takeover.available ? (
    <Button size="sm" variant="secondary" disabled={busy} aria-describedby="expanded-takeover-check"
      onPointerDown={takeover.onPointerDown} onKeyDown={takeover.onKeyDown} onClick={takeover.onRequest}>
      {busy ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <Hand aria-hidden="true" className="size-4" />}
      Take over
    </Button>
  ) : (
    <span id="expanded-takeover-check" className="max-w-40 text-right text-xs text-muted-foreground">Connect a keyboard and mouse to take over</span>
  ));

  return createPortal(
    <div ref={layer} role="dialog" aria-modal="true" aria-label={`${agentName} desktop, full screen`} onKeyDown={trapFocus}
      className="fixed inset-0 z-50 flex flex-col bg-background text-foreground animate-in fade-in slide-in-from-bottom-1 duration-200 motion-reduce:animate-none">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="hidden text-lg font-semibold tracking-tight sm:block">Eclipse Crew</span>
          <span aria-hidden="true" className="hidden h-6 w-px bg-border sm:block" />
          <button type="button" onClick={onExit} aria-label="Back to workspace"
            className="flex items-center gap-1 whitespace-nowrap text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            <ChevronLeft aria-hidden="true" className="size-4" /><span>Back<span className="hidden sm:inline"> to workspace</span></span>
          </button>
          <span aria-hidden="true" className="hidden h-6 w-px bg-border md:block" />
          <span aria-hidden="true" className="hidden size-8 shrink-0 items-center justify-center rounded-full border border-border text-xs font-semibold md:flex">{initials(agentName)}</span>
          <span className="hidden min-w-0 truncate text-sm font-semibold md:block">{agentName}</span>
          {astraMode && <span className="hidden md:inline-flex"><AstraBadge /></span>}
          <span className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <span aria-hidden="true" className={`size-2 rounded-full ${status === "live" ? "bg-foreground motion-safe:animate-pulse" : "bg-muted-foreground"}`} />{statusLabel}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <time className="hidden font-mono text-xs tabular-nums text-muted-foreground sm:block" aria-label="Local time">{clockText(new Date(now))}</time>
          {controlButton}
          <Button ref={exitButton} size="sm" variant="secondary" onClick={onExit}>
            <Minimize2 aria-hidden="true" className="size-4" />Exit full screen
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className={`flex min-h-0 flex-col overflow-hidden rounded-xl border bg-black ${takenOver ? "border-corona" : "border-border"}`}>
          {takenOver && <p className="bg-corona/12 px-3 py-2 text-center text-xs text-corona">You&apos;re in control. The agent is paused. Hand back to resume.</p>}
          {teachControls}
          <div className="relative min-h-0 flex-1" onKeyDown={onScreenKeyDown}>
            <div ref={slotRef} className="absolute inset-0" />
            {overlay}
            {status === "live" && !takenOver && <span className="pointer-events-none absolute bottom-2 right-2 rounded-md bg-surface px-2 py-1 text-xs text-muted-foreground">view-only</span>}
          </div>
          {error && status === "live" && <p role="alert" className="border-t border-border bg-background px-3 py-2 text-xs text-danger">{error}</p>}
          {status === "live" && !takenOver && takeover.available && !takeover.eligible && (
            <p id="expanded-takeover-check" className="border-t border-border bg-background px-3 py-2 text-xs text-muted-foreground">
              Input check: click Take over with your mouse, then press Enter to confirm your keyboard. This check never sends anything to the desktop.
            </p>
          )}
        </div>

        <aside aria-label="Desktop status" className="hidden min-h-0 flex-col gap-4 overflow-y-auto lg:flex">
          <section aria-labelledby="expanded-live-heading" className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-start justify-between gap-2">
              <h2 id="expanded-live-heading" className="text-lg font-semibold tracking-tight">Live desktop</h2>
              <span className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">{takenOver ? "In control" : "View only"}</span>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              {takenOver ? `You are controlling the ${agentName} desktop. The agent is paused.` : `Watching the ${agentName} desktop. Control remains with the agent.`}
            </p>
            <dl className="mt-4 divide-y divide-border text-sm">
              <div className="flex items-center justify-between gap-3 py-3"><dt className="flex items-center gap-3"><Monitor aria-hidden="true" className="size-4 text-muted-foreground" />Linux desktop</dt><dd className="text-muted-foreground">{status === "live" ? "Connected" : status === "connecting" ? "Connecting" : "Offline"}</dd></div>
              <div className="flex items-center justify-between gap-3 py-3"><dt className="flex items-center gap-3"><Timer aria-hidden="true" className="size-4 text-muted-foreground" />Session</dt><dd className="font-mono text-xs tabular-nums text-muted-foreground">{elapsedText(connectedAt, now)}</dd></div>
              <div className="flex items-center justify-between gap-3 py-3"><dt className="flex items-center gap-3"><Cuboid aria-hidden="true" className="size-4 text-muted-foreground" />Model</dt><dd className="truncate font-mono text-xs text-muted-foreground">{modelName ?? "Not set"}</dd></div>
            </dl>
          </section>

          <section aria-labelledby="expanded-task-heading" className="rounded-lg border border-border bg-card p-4">
            <h2 id="expanded-task-heading" className="text-lg font-semibold tracking-tight">Current task</h2>
            <p className="mt-3 flex items-start gap-3 text-sm text-muted-foreground">
              <FileText aria-hidden="true" className="mt-0.5 size-4 shrink-0" />Task status appears here once run tracking is added.
            </p>
          </section>

          <section aria-labelledby="expanded-safety-heading" className="rounded-lg border border-border bg-card p-4">
            <h2 id="expanded-safety-heading" className="text-lg font-semibold tracking-tight">Control safety</h2>
            <p className="mt-3 flex items-start gap-3 text-sm text-muted-foreground">
              <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />Take over to interact with the browser. Hand back when ready for the agent to continue.
            </p>
          </section>
        </aside>
      </div>
    </div>,
    document.body,
  );
}
