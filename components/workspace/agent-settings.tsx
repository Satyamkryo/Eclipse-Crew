"use client";
import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentForm } from "@/components/workspace/agent-form";
import { ModalDialog } from "@/components/workspace/modal-dialog";

export type AgentSettingsData = {
  id: string;
  name: string;
  role: string;
  soulMd: string;
  status: "active" | "paused";
  dailyBudgetCents: number;
  monthlyBudgetCents: number;
  tools: string[];
  domains: string[];
  actions: string[];
  memoryScopes: string[];
};

export function AgentSettings({ agent, desktopRunning, csrfToken }: { agent: AgentSettingsData; desktopRunning: boolean; csrfToken: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState<"pause" | "resume" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const action = agent.status === "paused" || !desktopRunning ? "resume" : "pause";
  const actionLabel = agent.status === "paused" ? "Resume agent" : desktopRunning ? "Pause agent" : "Start desktop";

  async function changeStatus(action: "pause" | "resume") {
    setLoading(action);
    setError(null);
    try {
      const response = await fetch(`/api/agents/${agent.id}/${action}`, {
        method: "POST",
        headers: { "x-csrf-token": csrfToken },
      });
      if (response.status === 401) {
        router.push("/login");
        router.refresh();
        return;
      }
      if (!response.ok) {
        setError(action === "pause" ? "Couldn't pause this agent. Try again." : "Couldn't resume this agent. Try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("Unable to connect. Try again.");
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold tracking-tight">Agent settings</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {agent.status === "paused" ? "Paused" : desktopRunning ? "Active · Desktop running" : "Active · Desktop stopped"} · Permissions are default deny.
            </p>
          </div>
          <Button type="button" variant="secondary" disabled={loading !== null}
            onClick={() => changeStatus(action)}>
            {loading && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
            {actionLabel}
          </Button>
        </div>
        {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
        <div className="mt-5">
          <AgentForm mode="edit" agentId={agent.id} csrfToken={csrfToken} initial={agent}
            onSaved={() => router.refresh()} />
        </div>
      </section>
      <section className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold">Delete agent</h3>
        <p className="mt-1 text-sm text-muted-foreground">Permanently removes this agent&apos;s desktop, browser profile, files and configuration.</p>
        <Button type="button" variant="destructive" className="mt-3" onClick={() => setConfirmingDelete(true)}>Delete agent</Button>
      </section>
      <div className="flex flex-wrap gap-4">
        <Link href="/settings/models" className="text-sm underline underline-offset-4">Model settings</Link>
        <Link href="/settings/account" className="text-sm underline underline-offset-4">Account settings</Link>
      </div>
      {confirmingDelete && <DeleteAgentDialog agent={agent} csrfToken={csrfToken} onClose={() => setConfirmingDelete(false)} />}
    </div>
  );
}

function DeleteAgentDialog({ agent, csrfToken, onClose }: { agent: AgentSettingsData; csrfToken: string; onClose: () => void }) {
  const router = useRouter();
  const errorRef = useRef<HTMLParagraphElement>(null);
  const [confirmation, setConfirmation] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (confirmation !== agent.name || !acknowledged) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/agents/${agent.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ confirmation, backupAcknowledged: acknowledged }),
      });
      if (response.status === 401) {
        router.push("/login");
        router.refresh();
        return;
      }
      if (!response.ok) {
        setError("Couldn't delete this agent. Close any live session and try again.");
        requestAnimationFrame(() => errorRef.current?.focus());
        return;
      }
      onClose();
      router.replace("/");
      router.refresh();
    } catch {
      setError("Unable to connect. Try again.");
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      setLoading(false);
    }
  }

  return (
    <ModalDialog title={`Delete ${agent.name}?`} onClose={onClose}
      description="Back up any files you need first. This permanently removes the agent's Linux user, browser profile, workspace, persona and permissions.">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label htmlFor="delete-agent-confirmation" className="text-sm font-medium">Type {agent.name} to confirm</label>
          <input id="delete-agent-confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off" className="h-8 rounded-md border border-input bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)}
            className="mt-0.5 size-4 rounded border-input" />
          I understand no backup will be made.
        </label>
        {error && <p ref={errorRef} role="alert" tabIndex={-1} className="text-sm text-danger">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="destructive" disabled={loading || confirmation !== agent.name || !acknowledged}
            onClick={remove}>
            {loading && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
            Delete agent
          </Button>
        </div>
      </div>
    </ModalDialog>
  );
}
