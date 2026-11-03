"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, MonitorOff } from "lucide-react";

import { viewOnlyStreamUrl } from "@/lib/desktop/stream";

type Viewer = { viewOnly: boolean; scaleViewport: boolean; resizeSession: boolean; background: string; disconnect(): void; addEventListener(type: string, callback: EventListener): void };

// TASK-058. A view-only frame. It never takes over, never sends input and only connects while the card is on screen and the
// tab is visible. All streams are released on unmount; the overview never starts a desktop to fill a slot.
export function DesktopThumbnail({ agentId, agentName }: { agentId: string; agentName: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [onScreen, setOnScreen] = useState(false);
  const [status, setStatus] = useState<"connecting" | "live" | "ended">("connecting");

  useEffect(() => {
    const element = hostRef.current;
    if (!element) return;
    const observer = new IntersectionObserver((entries) => {
      setOnScreen(Boolean(entries[0]?.isIntersecting));
    }, { threshold: 0.25 });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    if (!onScreen || !visible) return;
    const host = hostRef.current;
    if (!host) return;
    if (!stageRef.current) {
      const stage = document.createElement("div");
      stage.className = "absolute inset-0 overflow-hidden";
      stage.setAttribute("aria-label", `${agentName} live screen`);
      stageRef.current = stage;
    }
    host.appendChild(stageRef.current);
    let viewer: Viewer | undefined;
    let disposed = false;
    setStatus("connecting");
    const connect = async () => {
      try {
        const stateUrl = new URL(`/api/desktop/${agentId}/stream`, window.location.href);
        stateUrl.searchParams.set("connectionId", crypto.randomUUID());
        const streamHref = await viewOnlyStreamUrl(stateUrl.href);
        if (disposed) return;
        const { default: RFB } = await import("@novnc/novnc/lib/rfb.js");
        if (disposed) return;
        viewer = new RFB(stageRef.current!, streamHref);
        viewer.viewOnly = true;
        viewer.scaleViewport = true;
        viewer.resizeSession = false;
        viewer.background = "rgb(0, 0, 0)";
        viewer.addEventListener("connect", () => { if (!disposed) setStatus("live"); });
        viewer.addEventListener("disconnect", () => { if (!disposed) setStatus("ended"); });
      } catch {
        if (!disposed) setStatus("ended");
      }
    };
    void connect();
    return () => {
      disposed = true;
      viewer?.disconnect();
      stageRef.current?.remove();
    };
  }, [agentId, agentName, onScreen, visible]);

  return (
    <div ref={hostRef} className="relative aspect-[4/3] w-full overflow-hidden rounded-md border border-border bg-black">
      {(!onScreen || !visible || status === "ended") && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 bg-card text-center text-xs text-muted-foreground">
          {status === "ended" ? <MonitorOff aria-hidden="true" className="size-4" /> : <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
          <span>{status === "ended" ? "Stream ended" : "View-only frame"}</span>
        </div>
      )}
      {status === "connecting" && onScreen && visible && (
        <div className="absolute bottom-2 left-2 z-10 rounded bg-card/90 px-2 py-0.5 text-xs text-muted-foreground">Connecting…</div>
      )}
    </div>
  );
}
