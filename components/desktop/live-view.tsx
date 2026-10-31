"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getForwardedKeyChord } from "@/lib/desktop/key-chord";

type Lease = { generation: string; connectionId: string; leaseId: string };
type ActiveView = { generation: string; connectionId: string; csrfToken: string; disposed: boolean; lease: Lease | null; pending: number; inputBlocked: boolean };
type Viewer = { viewOnly: boolean; scaleViewport: boolean; resizeSession: boolean; disconnect(): void; addEventListener(type: string, callback: EventListener): void };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function LiveView({ agentId, agentName }: { agentId: string; agentName?: string }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const activeRef = useRef<ActiveView | null>(null);
  const composingRef = useRef(false);
  const queueRef = useRef(Promise.resolve());
  const [status, setStatus] = useState<"connecting" | "live" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [takenOver, setTakenOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const release = useCallback((keepalive = false, active = activeRef.current) => {
    if (!active?.lease) return Promise.resolve();
    const lease = active.lease;
    return fetch(`/api/desktop/${agentId}/handback`, {
      method: "POST", credentials: "same-origin", keepalive,
      headers: { "Content-Type": "application/json", "x-csrf-token": active.csrfToken }, body: JSON.stringify(lease),
    }).then((response) => {
      if (!response.ok) throw new Error("Hand back failed. Retry or close this desktop to release control.");
      if (active.lease === lease) active.lease = null;
      if (!active.disposed) setTakenOver(false);
    });
  }, [agentId]);

  useEffect(() => {
    const active = { generation: "", connectionId: crypto.randomUUID(), csrfToken: "", disposed: false, lease: null as Lease | null, pending: 0, inputBlocked: false };
    activeRef.current = active;
    const controller = new AbortController();
    let viewer: Viewer | undefined;
    const screen = screenRef.current;
    const pagehide = () => { void release(true, active).catch(() => {}); viewer?.disconnect(); };
    const connect = async () => {
      try {
        if (!UUID.test(agentId)) throw new Error("Select a valid agent.");
        const [csrfResponse, stateResponse, { default: RFB }] = await Promise.all([
          fetch("/api/auth/csrf", { cache: "no-store", signal: controller.signal }),
          fetch(`/api/desktop/${agentId}/stream?connectionId=${active.connectionId}`, { cache: "no-store", signal: controller.signal }),
          import("@novnc/novnc/lib/rfb.js"),
        ]);
        if (!csrfResponse.ok || !stateResponse.ok) throw new Error("Desktop unavailable. Check your login and that the agent is running.");
        const csrf = await csrfResponse.json(); const state = await stateResponse.json();
        if (!/^[0-9a-f]{64}$/.test(csrf.csrfToken) || !UUID.test(state.generation) || state.state !== "running") throw new Error("Agent is not running.");
        if (active.disposed || !screen) return;
        active.generation = state.generation; active.csrfToken = csrf.csrfToken;
        const url = new URL(`/api/desktop/${agentId}/stream`, window.location.href);
        url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("connectionId", active.connectionId);
        viewer = new RFB(screen, url.href);
        // Always view-only: owner input uses the separately guarded HTTP API.
        viewer.viewOnly = true; viewer.scaleViewport = true; viewer.resizeSession = false;
        viewer.addEventListener("connect", () => { if (!active.disposed) { setStatus("live"); setError(null); } });
        viewer.addEventListener("disconnect", () => {
          if (active.disposed) return;
          void release(true, active).catch(() => {});
          setTakenOver(false); setStatus("error");
          setError("Desktop disconnected. Reconnect to check the current agent session.");
        });
        viewer.addEventListener("securityfailure", () => { if (!active.disposed) setError("Desktop authentication failed. Reconnect to try again."); });
      } catch (failure) {
        if (!active.disposed) { setStatus("error"); setError(failure instanceof Error ? failure.message : "Unable to connect to the desktop."); }
      }
    };
    // State belongs to this external connection lifecycle.
    queueMicrotask(() => { if (!active.disposed) { setStatus("connecting"); setError(null); setTakenOver(false); setBusy(false); } });
    void connect();
    window.addEventListener("pagehide", pagehide);
    return () => {
      active.disposed = true; controller.abort();
      window.removeEventListener("pagehide", pagehide);
      void release(true, active).catch(() => {});
      viewer?.disconnect(); screen?.replaceChildren();
      if (activeRef.current === active) activeRef.current = null;
    };
  }, [agentId, attempt, release]);

  useEffect(() => { if (takenOver) textRef.current?.focus(); }, [takenOver]);

  const takeOver = async () => {
    const active = activeRef.current;
    if (!active || active.disposed || status !== "live") return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/desktop/${agentId}/takeover`, { method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(6000), headers: { "Content-Type": "application/json", "x-csrf-token": active.csrfToken }, body: JSON.stringify({ generation: active.generation, connectionId: active.connectionId }) });
      if (!response.ok) throw new Error("Take over failed. Check that no other view is in control and try again.");
      const result = await response.json();
      if (result.takenOver !== true || !UUID.test(result.leaseId) || result.generation !== active.generation) throw new Error("Take over could not be confirmed. Reconnect to release control.");
      active.lease = { generation: active.generation, connectionId: active.connectionId, leaseId: result.leaseId };
      active.inputBlocked = false;
      if (active.disposed) { void release(true, active).catch(() => {}); return; }
      setTakenOver(true);
    } catch (failure) { if (!active.disposed) setError((failure as Error).message); }
    finally { if (!active.disposed) setBusy(false); }
  };

  const handBack = async () => {
    setBusy(true); setError(null);
    try { await release(); } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };

  const sendInput = useCallback((payload: Record<string, unknown>) => {
    const active = activeRef.current; const lease = active?.lease;
    if (!active || active.disposed || !lease || active.inputBlocked) return;
    if (active.pending >= 32) { setError("Desktop input is busy. Wait for the current input to finish."); return; }
    active.pending++;
    queueRef.current = queueRef.current.then(async () => {
      if (active.disposed || active.lease !== lease || active.inputBlocked) return;
      const response = await fetch(`/api/desktop/${agentId}/input`, { method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(6000), headers: { "Content-Type": "application/json", "x-csrf-token": active.csrfToken }, body: JSON.stringify({ ...lease, ...payload }) });
      if (!response.ok) throw new Error("Desktop input was denied. Check the current takeover and try again.");
    }).catch(() => {
      active.inputBlocked = true;
      if (!active.disposed) setError("Desktop input could not be confirmed. Hand back control before trying again.");
    }).finally(() => { active.pending--; });
  }, [agentId]);

  const sendText = (text: string) => {
    if (!text) return;
    if (text.length > 4096) { setError("Paste up to 4096 characters at a time."); return; }
    sendInput({ operation: "input.type", text });
  };
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (!activeRef.current?.lease || composingRef.current || event.nativeEvent.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
    if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return;
    const key = getForwardedKeyChord({
      key: event.key,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      altGraph: event.getModifierState("AltGraph"),
    });
    if (!key) return;
    event.preventDefault();
    sendInput({ operation: "input.key", key });
  };
  const click = (event: React.MouseEvent, button: "left" | "right") => {
    if (!activeRef.current?.lease) return;
    const canvas = screenRef.current?.querySelector("canvas");
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom || !rect.width || !rect.height) return;
    event.preventDefault(); textRef.current?.focus();
    sendInput({ operation: "input.click", button, x: Math.min(canvas.width - 1, Math.floor((event.clientX - rect.left) * canvas.width / rect.width)), y: Math.min(canvas.height - 1, Math.floor((event.clientY - rect.top) * canvas.height / rect.height)) });
  };

  return (
    <div ref={frameRef} aria-label={agentName ? `Live view of ${agentName}` : "Live desktop view"} className={`flex flex-col overflow-hidden rounded-xl border bg-background ${takenOver ? "border-corona" : "border-border"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-3 py-2">
        <div className="flex items-center gap-2 text-xs">
          <span aria-hidden="true" className={`h-2 w-2 rounded-full ${status === "live" ? "motion-safe:animate-pulse bg-foreground" : "bg-muted-foreground"}`} />
          <span className="font-medium">{agentName ?? "Agent desktop"}</span>
          <span className="text-muted-foreground" role="status">{status === "live" ? "Live" : status === "connecting" ? "Connecting…" : "Offline"}</span>
        </div>
        <div className="flex items-center gap-2">
          {status === "live" && <Button size="sm" variant={takenOver ? "primary" : "secondary"} disabled={busy} onClick={takenOver ? handBack : takeOver}>{busy && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}{takenOver ? "Hand back" : "Take over"}</Button>}
          <Button size="sm" variant="ghost" title="Full screen" aria-label="Full screen" onClick={() => { void frameRef.current?.requestFullscreen?.().catch(() => setError("Full screen is unavailable in this browser.")); }}><Maximize2 aria-hidden="true" className="h-4 w-4" /></Button>
        </div>
      </div>
      {takenOver && <p className="bg-corona/12 px-3 py-2 text-center text-xs text-corona">You&apos;re in control. The agent is paused. Hand back to resume.</p>}
      <div className="relative aspect-[4/3] min-h-0 w-full bg-background" onKeyDown={handleKeyDown}>
        <div ref={screenRef} className="absolute inset-0 overflow-hidden" aria-label="Agent screen" />
        {takenOver && <div className="absolute inset-0 cursor-crosshair" onClick={(event) => click(event, "left")} onContextMenu={(event) => click(event, "right")} onWheel={(event) => { sendInput({ operation: "input.scroll", direction: event.deltaY < 0 ? "up" : "down", count: 1 }); }}>
          <textarea ref={textRef} className="sr-only" aria-label="Type into agent desktop" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={(event) => { composingRef.current = false; sendText(event.currentTarget.value); event.currentTarget.value = ""; }} onChange={(event) => { if (!composingRef.current) { sendText(event.currentTarget.value); event.currentTarget.value = ""; } }} onPaste={(event) => { event.preventDefault(); sendText(event.clipboardData.getData("text/plain")); }} />
        </div>}
        {status !== "live" && <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center">
          {status === "connecting" ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" /> : <AlertTriangle className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
          <p className="text-sm text-muted-foreground">{status === "connecting" ? "Connecting to agent desktop…" : error ?? "Agent is not running."}</p>
          {status !== "connecting" && <Button variant="secondary" size="sm" onClick={() => setAttempt((value) => value + 1)}>Reconnect</Button>}
        </div>}
        {status === "live" && !takenOver && <span className="pointer-events-none absolute bottom-2 right-2 rounded-md bg-surface px-2 py-1 text-xs text-muted-foreground">view-only</span>}
      </div>
      {error && status === "live" && <p role="alert" className="border-t border-border px-3 py-2 text-xs text-danger">{error}</p>}
    </div>
  );
}
