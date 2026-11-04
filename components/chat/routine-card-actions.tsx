"use client";

import { useEffect, useState } from "react";
import { CalendarCheck, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RoutineRunNow } from "@/components/chat/routine-run-now";

type State =
  | { status: "ready" | "confirming" }
  | { status: "confirmed"; routineId: string }
  | { status: "error"; text?: string };

function routineIdOf(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

export function RoutineCardActions({ agentId, messageId, csrfToken }: {
  agentId: string; messageId: string; csrfToken: string;
}) {
  const [state, setState] = useState<State>({ status: "ready" });
  const url = `/api/agents/${agentId}/routines/${messageId}`;

  useEffect(() => {
    let cancelled = false;
    fetch(url, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error();
      const body = await response.json() as { routine?: unknown };
      const routineId = routineIdOf(body.routine);
      if (!cancelled) setState(routineId ? { status: "confirmed", routineId }
        : body.routine ? { status: "error", text: "Couldn't read this saved routine. Reload the page." } : { status: "ready" });
    }).catch(() => { if (!cancelled) setState({ status: "error", text: "Couldn't check whether this routine is saved. Try again." }); });
    return () => { cancelled = true; };
  }, [url]);

  async function confirm() {
    if (state.status === "confirming" || state.status === "confirmed") return;
    setState({ status: "confirming" });
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({}),
      });
      if (response.status === 201 || response.status === 200) {
        const body = await response.json() as { routine?: unknown };
        const routineId = routineIdOf(body.routine);
        if (!routineId) throw new Error();
        setState({ status: "confirmed", routineId });
        window.dispatchEvent(new CustomEvent("eclipse-notify", {
          detail: { title: "Routine saved", text: "It will run on schedule. Run now to test it.", agentId, actionLabel: "Open Schedules", actionHref: "/schedules" },
        }));
        return;
      }
      if (response.status === 409) {
        setState({ status: "error", text: "That schedule is no longer valid. Ask the agent to propose it again." });
        return;
      }
      throw new Error();
    } catch {
      setState({ status: "error", text: "Couldn't save this routine. Try again." });
    }
  }

  if (state.status === "confirmed") return (
    <>
      <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground" role="status">
        <CalendarCheck aria-hidden="true" className="size-4" />Routine saved
      </p>
      <RoutineRunNow routineId={state.routineId} csrfToken={csrfToken} />
    </>
  );
  return (
    <div className="mt-4 flex flex-col items-end gap-2">
      <Button type="button" onClick={confirm} disabled={state.status === "confirming"} aria-label="Confirm routine">
        {state.status === "confirming" && <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />}
        Confirm routine
      </Button>
      {state.status === "error" && <p role="alert" className="text-xs text-danger">{state.text}</p>}
    </div>
  );
}
