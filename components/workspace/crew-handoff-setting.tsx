"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AgentCrew } from "@/components/workspace/agent-settings";

// ADR-036. Shown only for agents in a crew. Turns handoff on or off for every member of this crew together; a
// receiver always works with its own permissions and budget, and handoff never leaves the crew.
export function CrewHandoffSetting({ crew, csrfToken }: { crew: AgentCrew; csrfToken: string }) {
  const router = useRouter();
  const [on, setOn] = useState(crew.handoffOn);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function update(enabled: boolean) {
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/agents/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ enabled, agentIds: crew.agentIds }),
      });
      if (response.status === 401) { router.push("/login"); router.refresh(); return; }
      if (!response.ok) { setError("Couldn't update handoff for this crew. Try again."); return; }
      setOn(enabled);
      setMessage(enabled ? `Handoff is on for ${crew.name}.` : `Handoff is off for ${crew.name}. Each agent now keeps its own requests.`);
      router.refresh();
    } catch {
      setError("Unable to connect. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Crew handoff · {crew.name}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {on
              ? "On. Agents in this crew can pass a request to the crewmate whose job it is. Handoff never leaves the crew, and the receiver uses its own permissions and budget."
              : "Off. Agents in this crew keep every request themselves. You can still send a message to any agent with @Name."}
          </p>
        </div>
        <Button type="button" variant="secondary" disabled={pending} onClick={() => void update(!on)} aria-busy={pending}>
          {pending && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
          {on ? "Turn off handoff" : "Turn on handoff"}
        </Button>
      </div>
      {message && <p role="status" className="mt-2 text-xs text-muted-foreground">{message}</p>}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  );
}
