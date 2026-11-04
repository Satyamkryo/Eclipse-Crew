"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DesktopStatus } from "@/lib/desktop/client";

type Action = "start" | "stop" | "start-browser" | "stop-browser";

const ERROR_TEXT: Record<string, string> = {
  agent_paused: "This agent is paused. Resume the agent first.",
  security_stopped: "This agent is stopped for security review. Resolve it in the Security Center.",
  crew_stopped: "The crew is stopped. Resume the crew in the Security Center.",
  budget_exhausted: "This agent is at its budget limit. Raise it or wait for the next period.",
  profile_busy_or_unsafe: "The browser profile is still in use. Close the other window and try again.",
  display_conflict: "Another display is already using this agent's screen, so it was left untouched.",
  browser_start_failed: "The browser could not be started. Close any other window using it and try again.",
  desktop_start_failed: "The desktop could not be started. Check the desktop service and try again.",
  desktop_stop_failed: "The desktop could not be stopped. Try again.",
  browser_stop_failed: "The browser could not be stopped. Try again.",
  desktop_unavailable: "The desktop service is unavailable.",
};
const errorText = (code: string | undefined) => (code && ERROR_TEXT[code]) || "Something went wrong. Try again.";

// Longer than the app's 45 s lifecycle timeout, so a slow but healthy action still returns its own error.
const ACTION_TIMEOUT_MS = 75_000;
const REFRESH_TIMEOUT_MS = 10_000;
const SETTLE_TIMEOUT_MS = 20_000;
const SETTLE_INTERVAL_MS = 1_000;

function settled(action: Action, status: DesktopStatus): boolean {
  if (action === "stop") return status.graphics !== "running" && status.graphics !== "starting";
  if (action === "start") return status.graphics === "running" || status.graphics === "failed";
  if (action === "stop-browser") return status.browser !== "running" && status.browser !== "starting";
  return status.browser === "running" || status.browser === "failed";
}

function statusLabel(status: DesktopStatus): string {
  if (status.sandbox === "starting" || status.graphics === "starting") return "Starting the desktop…";
  if (status.graphics === "failed") return "Desktop failed";
  if (status.graphics === "running") {
    if (status.browser === "running") return "Desktop and browser running";
    if (status.browser === "starting") return "Desktop running · Browser starting…";
    if (status.browser === "failed") return "Desktop running · Browser failed";
    return "Desktop running · Browser stopped";
  }
  if (status.browser === "failed") return "Browser failed";
  return "Desktop stopped";
}

export function DesktopLifecycle({ agentId, csrfToken, initial }: { agentId: string; csrfToken: string; initial?: DesktopStatus }) {
  const router = useRouter();
  const [status, setStatus] = useState<DesktopStatus>(initial ?? { agentId, state: "stopped", sandbox: "stopped", graphics: "stopped", browser: "stopped" });
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inFlight = useRef(false);
  const unmounted = useRef(false);
  useEffect(() => () => { unmounted.current = true; }, []);

  // Bounded and always drains the body, so a stalled or unread response can never pin the button or hold a connection.
  const refresh = useCallback(async (): Promise<DesktopStatus | null> => {
    const response = await fetch(`/api/agents/${agentId}/desktop`, { cache: "no-store", signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) });
    if (response.status === 401) { await response.body?.cancel().catch(() => undefined); router.push("/login"); return null; }
    const body = await response.json().catch(() => null) as DesktopStatus | null;
    if (!response.ok || !body) return null;
    if (!unmounted.current) setStatus(body);
    return body;
  }, [agentId, router]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.hidden || inFlight.current) return;
      inFlight.current = true;
      void refresh().catch(() => undefined).finally(() => { inFlight.current = false; });
    }, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  // Polls until the desktop reports the state the action asked for, or tells the owner it never confirmed.
  async function settle(action: Action) {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (!unmounted.current && Date.now() < deadline) {
      const current = await refresh().catch(() => null);
      if (current && settled(action, current)) return;
      await new Promise((resolve) => setTimeout(resolve, SETTLE_INTERVAL_MS));
    }
    if (!unmounted.current) setError("The desktop didn't confirm the change. Refresh to check its state.");
  }

  async function act(action: Action) {
    setBusy(action);
    setError(null);
    let ok = false;
    try {
      const response = await fetch(`/api/agents/${agentId}/desktop`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ action }),
        signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (response.status === 401) { router.push("/login"); return; }
      if (!response.ok) { setError(errorText(body.error)); return; }
      ok = true;
    } catch (error) {
      setError(error instanceof DOMException && error.name === "TimeoutError"
        ? "The desktop is taking too long to respond. Try again."
        : "Unable to connect. Try again.");
    } finally {
      setBusy(null);
    }
    if (!ok) return;
    // The server adds or removes the live view; chat is a client component and keeps its state.
    router.refresh();
    await settle(action);
  }

  const running = status.graphics === "running";
  const starting = status.sandbox === "starting" || status.graphics === "starting" || status.browser === "starting";
  const browserRunning = status.browser === "running";

  return (
    <section aria-live="polite" className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Desktop</h3>
          <p className="mt-1 text-sm text-muted-foreground">{statusLabel(status)}</p>
          {status.reason && ERROR_TEXT[status.reason] ? <p className="mt-1 text-xs text-muted-foreground">{ERROR_TEXT[status.reason]}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {running ? (
            <Button type="button" variant="secondary" size="sm" disabled={busy !== null} onClick={() => void act("stop")}>
              {busy === "stop" && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
              Stop desktop
            </Button>
          ) : (
            <Button type="button" variant="secondary" size="sm" disabled={busy !== null || starting} onClick={() => void act("start")}>
              {(busy === "start" || starting) && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
              Start desktop
            </Button>
          )}
          {running && (browserRunning ? (
            <Button type="button" variant="secondary" size="sm" disabled={busy !== null} onClick={() => void act("stop-browser")}>
              {busy === "stop-browser" && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
              Stop browser
            </Button>
          ) : (
            <Button type="button" variant="secondary" size="sm" disabled={busy !== null || status.browser === "starting"} onClick={() => void act("start-browser")}>
              {(busy === "start-browser" || status.browser === "starting") && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
              Start browser
            </Button>
          ))}
        </div>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
    </section>
  );
}
