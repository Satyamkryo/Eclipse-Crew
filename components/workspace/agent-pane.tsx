"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, Gauge, Plus, ShieldAlert, ShieldQuestion, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentForm } from "@/components/workspace/agent-form";
import { AgentAvatar } from "@/components/workspace/agent-avatar";
import { ModalDialog } from "@/components/workspace/modal-dialog";
import { AstraBadge } from "@/components/ui/astra-badge";
import { cn } from "@/lib/utils";

export type AgentAttention = "budget_warning" | "budget_paused" | "teach_paused" | "security_stop" | "approval_pending";
export type AgentSummary = { id: string; name: string; role: string; status: "active" | "paused"; astraMode: boolean; avatarVariant: number; attention?: AgentAttention | null };

type Props = { agents: AgentSummary[]; selectedAgentId?: string; error?: string; csrfToken: string; variant?: "pane" | "sidebar" };
type Toast = { agentId: string; title: string; text: string; persistent: boolean; security?: boolean; approval?: boolean; actionLabel?: string; actionHref?: string };

export function AgentPane({ agents, selectedAgentId, error, csrfToken, variant = "pane" }: Props) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [attention, setAttention] = useState<Record<string, AgentAttention>>(() => Object.fromEntries(
    agents.flatMap((agent) => agent.attention ? [[agent.id, agent.attention]] : []),
  ));
  const [toast, setToast] = useState<Toast | null>(null);
  const announced = useRef(new Set<string>());

  useEffect(() => {
    let polling = false;
    const poll = async () => {
      if (polling || document.visibilityState !== "visible") return;
      polling = true;
      try {
        const response = await fetch("/api/agents/attention", { cache: "no-store" });
        if (response.status === 401) { router.push("/login"); router.refresh(); return; }
        if (!response.ok) return;
        const body = await response.json().catch(() => null) as { agents?: Array<{ id: string; attention: string | null; updatedAt: string }> } | null;
        if (!body?.agents || !Array.isArray(body.agents)) return;
        const next: Record<string, AgentAttention> = {};
        for (const item of body.agents) {
          if (item.attention !== "budget_warning" && item.attention !== "budget_paused" && item.attention !== "teach_paused" &&
              item.attention !== "security_stop" && item.attention !== "approval_pending") continue;
          next[item.id] = item.attention;
          const key = `${item.id}:${item.attention}:${item.updatedAt}`;
          if (announced.current.has(key)) continue;
          announced.current.add(key);
          const name = agents.find((agent) => agent.id === item.id)?.name ?? "An agent";
          setToast(item.attention === "security_stop"
            ? { agentId: item.id, title: `${name}: security stop`, text: "A canary secret was found in data this agent was about to send. The desktop was stopped and the agent is paused. Review what happened, then resume the agent.", persistent: true, security: true, actionLabel: "Open settings", actionHref: `/?agent=${item.id}&panel=settings` }
            : item.attention === "approval_pending"
            ? { agentId: item.id, title: `${name}: approval needed`, text: "An action is waiting for your decision in chat. Open the chat to allow or deny it.", persistent: true, approval: true, actionLabel: "Open chat", actionHref: `/?agent=${item.id}` }
            : item.attention === "teach_paused"
            ? { agentId: item.id, title: `${name}: recording paused`, text: "Recording paused for privacy. Check the managed browser, then resume explicitly or stop recording.", persistent: true, actionLabel: "Open chat", actionHref: `/?agent=${item.id}` }
            : item.attention === "budget_paused"
            ? { agentId: item.id, title: `${name}: budget paused`, text: "Raise the budget or wait for the next period, then resume the agent.", persistent: true, actionLabel: "Open settings", actionHref: `/?agent=${item.id}&panel=settings` }
            : { agentId: item.id, title: `${name}: budget warning`, text: "Spending reached 80%. The agent pauses before another model call at 100%.", persistent: false, actionLabel: "Open settings", actionHref: `/?agent=${item.id}&panel=settings` });
        }
        setAttention(next);
      } catch {
        // A later poll retries.
      } finally {
        polling = false;
      }
    };
    void poll();
    const interval = window.setInterval(() => { void poll(); }, 5000);
    const onVisibility = () => { if (document.visibilityState === "visible") void poll(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { window.clearInterval(interval); document.removeEventListener("visibilitychange", onVisibility); };
  }, [agents, router]);

  useEffect(() => {
    if (!toast || toast.persistent) return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Orbit-style success/info toasts: any component can dispatch
  // window.dispatchEvent(new CustomEvent("eclipse-notify", { detail: { title, text, agentId?, href? } }))
  useEffect(() => {
    const onNotify = (event: Event) => {
      const detail = (event as CustomEvent<{ title?: string; text?: string; agentId?: string; actionLabel?: string; actionHref?: string }>).detail;
      if (!detail?.title) return;
      setToast({ agentId: detail.agentId ?? "", title: detail.title, text: detail.text ?? "", persistent: false, actionLabel: detail.actionLabel, actionHref: detail.actionHref });
    };
    window.addEventListener("eclipse-notify", onNotify as EventListener);
    return () => window.removeEventListener("eclipse-notify", onNotify as EventListener);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {variant === "sidebar" ? (
        <div className="flex h-11 shrink-0 items-center justify-between px-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Agents</p>
          <Button type="button" variant="ghost" size="sm" aria-label="Create agent" title="Create agent" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" className="size-4" />
          </Button>
        </div>
      ) : (
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
          <h2 className="text-lg font-semibold tracking-tight">Agents</h2>
          <Button type="button" size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" className="size-4" />Create agent
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error && <p role="alert" className="mb-3 rounded-md border border-danger px-3 py-2 text-sm text-danger">{error}</p>}
        {agents.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <span className="flex size-9 items-center justify-center rounded-full border border-border" aria-hidden="true">
              <Bot className="size-4" />
            </span>
            <div>
              <p className="text-sm font-medium">No agents yet.</p>
              <p className="mt-1 text-sm text-muted-foreground">Create an agent to give it an isolated desktop, browser and files.</p>
            </div>
            <Button type="button" size="sm" onClick={() => setCreating(true)}>Create agent</Button>
          </div>
        ) : (
          <ul aria-label="Agents" className="flex flex-col gap-1">
            {agents.map((agent) => {
              const selected = agent.id === selectedAgentId;
              const needsYou = attention[agent.id];
              return (
                <li key={agent.id}>
                  <Link href={`/?agent=${agent.id}`} aria-current={selected ? "page" : undefined}
                    className={cn("flex min-w-0 items-center gap-3 rounded-md border border-transparent px-2 py-2 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
                      selected ? "border-border-strong bg-surface-hover" : "hover:bg-surface-hover")}>
                    <span className={cn("shrink-0 rounded-full", needsYou && "ring-1 ring-corona")}>
                      <AgentAvatar seed={agent.id} variant={agent.avatarVariant} size={36} label={`${agent.name} avatar`} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className={cn("min-w-0 truncate text-sm font-medium", agent.status === "paused" && !needsYou && "text-subtle")}>{agent.name}</span>
                        {agent.astraMode && <AstraBadge />}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">{agent.role}</span>
                    </span>
                    {needsYou ? <span className="shrink-0 text-xs font-medium text-corona">Needs you</span>
                      : agent.status === "paused" && <span className="text-xs text-muted-foreground">Paused</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {toast && (
        <div role={toast.persistent ? "alert" : "status"} aria-live={toast.persistent ? "assertive" : "polite"}
          className={cn("fixed bottom-3 left-3 right-3 z-50 flex items-start gap-3 rounded-lg border bg-surface-raised p-3 text-sm shadow-[0_8px_30px_rgba(0,0,0,0.5)] sm:left-auto sm:right-4 sm:w-80",
            toast.security ? "border-danger" : "border-corona")}>
          {toast.security
            ? <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
            : toast.approval
            ? <ShieldQuestion aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-corona" />
            : <Gauge aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-corona" />}
          <div className="min-w-0 flex-1">
            <p className={cn("font-medium", toast.security ? "text-danger" : "text-corona")}>{toast.title}</p>
            <p className="mt-1 text-xs text-muted-foreground">{toast.text}</p>
            {toast.actionLabel && toast.actionHref && (
              <Link href={toast.actionHref} onClick={() => setToast(null)}
                className="mt-2 inline-flex h-7 items-center rounded-md border border-border-strong bg-surface px-2.5 text-xs font-medium transition-colors duration-150 hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-ring">
                {toast.actionLabel}
              </Link>
            )}
          </div>
          <button type="button" onClick={() => setToast(null)} aria-label="Dismiss attention alert"
            className="rounded-md p-1 text-muted-foreground hover:bg-surface-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
      )}
      {creating && (
        <ModalDialog title="Create agent" description="The agent gets its own Linux user, desktop and Chromium profile."
          onClose={() => setCreating(false)}>
          <AgentForm mode="create" csrfToken={csrfToken}
            onSaved={(agentId) => {
              setCreating(false);
              if (agentId) router.push(`/?agent=${agentId}`);
              router.refresh();
            }}
            onCancel={() => setCreating(false)} />
        </ModalDialog>
      )}
    </div>
  );
}
