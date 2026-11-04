"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, CircleAlert, LoaderCircle, UsersRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AGENT_TEMPLATES, STARTER_TEMPLATE_IDS } from "@/lib/agents/templates";
import type { StarterCrewView } from "@/lib/crew/schema";

type Draft = { schedule: string; goal: string };

// The starter preview is the six original roles; the gallery offers the full list.
const STARTER_TEMPLATES = STARTER_TEMPLATE_IDS.map((id) => AGENT_TEMPLATES.find((template) => template.id === id)!);

const INITIAL_DRAFTS: Record<string, Draft> = Object.fromEntries(
  STARTER_TEMPLATES.map((template) => [template.id, { ...(template.routineExamples[0] ?? { schedule: "", goal: "" }) }]),
);

export function StarterCrew({ initial, csrfToken }: { initial: StarterCrewView; csrfToken: string }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(INITIAL_DRAFTS);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const inProgress = view.summary.inProgress;

  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (!alive.current || inFlight.current) return;
      inFlight.current = true;
      try {
        const response = await fetch("/api/crew/starter", { cache: "no-store" });
        if (response.status === 401) { router.push("/login"); return; }
        if (!response.ok) throw new Error();
        const next = await response.json() as StarterCrewView;
        if (!alive.current) return;
        setView(next);
        if (next.summary.inProgress === 0) return;
      } catch {
        if (alive.current) setError("Couldn't check setup progress. Retry when the app is reachable.");
        return;
      } finally {
        inFlight.current = false;
      }
      if (alive.current && document.visibilityState === "visible") timer = setTimeout(() => { void load(); }, 2000);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") { if (timer) clearTimeout(timer); void load(); }
      else if (timer) clearTimeout(timer);
    };
    document.addEventListener("visibilitychange", onVisibility);
    if (inProgress > 0) void load();
    return () => {
      alive.current = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [router, inProgress]);

  async function create() {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/crew/starter", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: "{}",
      });
      if (response.status === 401) { router.push("/login"); return; }
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(result.error === "service_unavailable"
          ? "The crew setup could not start. Nothing was removed; try again."
          : "Couldn't create the starter crew. Try again.");
        return;
      }
      setView(result as StarterCrewView);
      router.refresh();
    } catch {
      setError("Unable to connect. Try again.");
    } finally {
      setCreating(false);
    }
  }

  function setDraft(id: string, change: Partial<Draft>) {
    setDrafts((current) => ({ ...current, [id]: { ...current[id], ...change } }));
  }

  const hasFailed = view.members.some((member) => member.state === "failed");
  const complete = view.setup?.state === "complete";

  return (
    <section aria-labelledby="starter-crew-heading" className="rounded-lg border border-border bg-card p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="starter-crew-heading" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <UsersRound aria-hidden="true" className="size-4 text-muted-foreground" />Starter crew
          </h2>
          <p className="mt-1 max-w-[80ch] text-sm text-muted-foreground">
            Six roles with their own Linux user, desktop and default-deny policy. This creates identities and setup
            checklists only: it does not connect mail or calendar accounts, copy credentials, or enable a routine.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!complete && (
            <Button type="button" onClick={create} disabled={creating}>
              {creating && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
              {view.setup ? (hasFailed ? "Retry failed setup" : "Resume setup") : "Create starter crew"}
            </Button>
          )}
          {complete && (
            <span className="inline-flex items-center gap-1 text-sm text-success">
              <CheckCircle2 aria-hidden="true" className="size-4" />Crew created
            </span>
          )}
        </div>
      </div>

      {error && <p role="alert" className="mt-3 flex items-start gap-2 text-sm text-danger"><CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{error}</p>}

      {view.setup ? (
        <div className="mt-5 flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            {view.summary.created} of {view.summary.total} agents created
            {view.summary.failed > 0 ? ` · ${view.summary.failed} need attention` : ""}
            {view.summary.inProgress > 0 ? " · working…" : ""}. A retry reuses the same identities.
          </p>
          <ul className="grid gap-2 md:grid-cols-2" aria-label="Starter crew members">
            {view.members.map((member) => {
              const template = AGENT_TEMPLATES.find((item) => item.id === member.templateId);
              return (
                <li key={member.templateId} className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm">{member.agentName ?? template?.label ?? member.templateId}</p>
                    <p className="text-xs text-muted-foreground">{template?.role ?? "Unknown role"}</p>
                    {member.state === "failed" && (
                      <p className="mt-1 text-xs text-corona">
                        Setup stopped: {member.errorCode === "desktop_setup_failed" ? "the desktop did not start. The paused agent is kept; Retry resumes it." : member.errorCode === "agent_create_failed" ? "the agent record could not be created. Retry is safe." : member.errorCode ?? "unknown error"}
                      </p>
                    )}
                  </div>
                  <MemberState state={member.state} />
                </li>
              );
            })}
          </ul>
          {!complete && (
            <p className="text-xs text-muted-foreground">Missing accounts, domains and pinned tools stay listed on each agent&apos;s setup checklist.</p>
          )}
        </div>
      ) : (
        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {STARTER_TEMPLATES.map((template) => {
            const draft = drafts[template.id] ?? { schedule: "", goal: "" };
            return (
              <article key={template.id} className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-3">
                <div>
                  <h3 className="text-sm font-semibold">{template.label}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">{template.description}</p>
                </div>
                <p className="text-xs text-muted-foreground">
                  ${template.dailyBudgetUsd}/day · ${template.monthlyBudgetUsd}/month · {accessSummary(template.actions)}
                </p>
                <dl className="text-xs">
                  <dt className="text-muted-foreground">Draft routine (not enabled)</dt>
                  <dd className="mt-1 flex flex-col gap-1.5">
                    <label className="sr-only" htmlFor={`draft-schedule-${template.id}`}>Schedule for {template.label}</label>
                    <input id={`draft-schedule-${template.id}`} value={draft.schedule}
                      onChange={(event) => setDraft(template.id, { schedule: event.target.value })}
                      maxLength={200}
                      className="h-7 w-full rounded-md border border-input bg-surface px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring" />
                    <label className="sr-only" htmlFor={`draft-goal-${template.id}`}>Goal for {template.label}</label>
                    <textarea id={`draft-goal-${template.id}`} value={draft.goal}
                      onChange={(event) => setDraft(template.id, { goal: event.target.value })}
                      maxLength={500} rows={2}
                      className="w-full rounded-md border border-input bg-surface px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-ring" />
                  </dd>
                </dl>
                <ul className="mt-auto flex flex-col gap-1 text-xs text-muted-foreground" aria-label={`${template.label} setup needs`}>
                  {template.needs.slice(0, 2).map((need) => <li key={need}>· {need}</li>)}
                </ul>
              </article>
            );
          })}
        </div>
      )}
      {!view.setup && (
        <p className="mt-4 text-xs text-muted-foreground">
          Drafts above stay in this preview. Once an agent exists, save a routine from its chat to enable it.
        </p>
      )}
    </section>
  );
}

function MemberState({ state }: { state: StarterCrewView["members"][number]["state"] }) {
  if (state === "created") return <span className="inline-flex shrink-0 items-center gap-1 text-xs text-success"><CheckCircle2 aria-hidden="true" className="size-3.5" />Ready</span>;
  if (state === "failed") return <span className="inline-flex shrink-0 items-center gap-1 text-xs text-corona"><CircleAlert aria-hidden="true" className="size-3.5" />Retry</span>;
  return <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground")}><LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />{state === "creating" ? "Creating" : "Queued"}</span>;
}

function accessSummary(actions: string[]) {
  if (actions.includes("tool_call")) return "tool calls";
  if (actions.includes("shell")) return "shell and tools";
  if (actions.some((action) => ["click", "type", "key", "scroll", "wait"].includes(action))) return "desktop and browser";
  return "no extra actions";
}
