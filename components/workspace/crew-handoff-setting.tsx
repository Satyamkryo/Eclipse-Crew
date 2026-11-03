"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

// TASK-085. Existing agents keep their permissions until the owner explicitly enables handoff for the whole crew.
export function CrewHandoffSetting({ csrfToken }: { csrfToken: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function enableAll() {
    setPending(true);
    setError(null);
    setDone(false);
    try {
      const response = await fetch("/api/agents/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ enabled: true }),
      });
      if (response.status === 401) { router.push("/login"); router.refresh(); return; }
      if (!response.ok) { setError("Couldn't update the crew's handoff permission. Try again."); return; }
      const body = await response.json().catch(() => null) as { changed?: number } | null;
      setDone(true);
      router.refresh();
      if (body && body.changed === 0) setError(null);
    } catch {
      setError("Unable to connect. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold">Crew handoff</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Teammates can pass a request to the agent whose job it is. The receiver always uses its own permissions and budget.
      </p>
      <Button type="button" variant="secondary" className="mt-3" disabled={pending} onClick={enableAll} aria-busy={pending}>
        {pending && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
        Allow handoff for all agents
      </Button>
      {done && <p role="status" className="mt-2 text-xs text-muted-foreground">Handoff is now on for every agent you own.</p>}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  );
}
