"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, CircleAlert, LoaderCircle, Plus, Shuffle, Trash2, UsersRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/workspace/modal-dialog";
import { AgentAvatar, AVATAR_COUNT, randomAvatarVariant } from "@/components/workspace/agent-avatar";
import { cn } from "@/lib/utils";
import type { CrewView } from "@/lib/crew/custom";

type MemberDraft = { name: string; role: string; soulMd: string; dailyBudgetUsd: string; monthlyBudgetUsd: string; avatarVariant: number };

const blankMember = (): MemberDraft => ({ name: "", role: "", soulMd: "", dailyBudgetUsd: "", monthlyBudgetUsd: "", avatarVariant: randomAvatarVariant() });
const BUDGET_PATTERN = /^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/;

function memberError(member: MemberDraft): string | null {
  if (!member.name.trim() || !member.role.trim()) return "Each member needs a name and a role.";
  if (member.soulMd && member.soulMd.length > 2000) return "Persona is at most 2000 characters.";
  for (const value of [member.dailyBudgetUsd, member.monthlyBudgetUsd]) {
    if (value.trim() && !BUDGET_PATTERN.test(value.trim())) return "Budgets look like 5.00 (blank keeps $5/day, $50/month).";
  }
  return null;
}

export function CustomCrews({ csrfToken }: { csrfToken: string }) {
  const router = useRouter();
  const [crews, setCrews] = useState<CrewView[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [members, setMembers] = useState<MemberDraft[]>([blankMember()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<{ crewId: string; text: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const response = await fetch("/api/crews", { cache: "no-store" });
        if (cancelled) return;
        if (response.status === 401) { router.push("/login"); return; }
        if (!response.ok) throw new Error();
        const next = await response.json() as { crews: CrewView[] };
        if (cancelled) return;
        setCrews(next.crews);
        setLoadError(false);
        if (next.crews.some((crew) => crew.summary.inProgress > 0)) {
          timer = setTimeout(() => { void load(); }, 5000);
          return;
        }
      } catch {
        if (!cancelled) setLoadError(true);
      } finally {
        inFlight = false;
      }
    };
    void load();
    const onVisibility = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { cancelled = true; document.removeEventListener("visibilitychange", onVisibility); if (timer) clearTimeout(timer); };
  }, [router]);

  async function refresh() {
    try {
      const response = await fetch("/api/crews", { cache: "no-store" });
      if (response.status === 401) { router.push("/login"); return; }
      if (!response.ok) throw new Error();
      const next = await response.json() as { crews: CrewView[] };
      setCrews(next.crews);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }

  // Resumes failed or abandoned members with the same agent identities. The server claims each member, so a double
  // click or a second tab never sets one up twice.
  async function retry(crewId: string) {
    if (retrying) return;
    setRetrying(crewId);
    setRetryError(null);
    try {
      const response = await fetch(`/api/crews/${crewId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: "{}",
      });
      if (response.status === 401) { router.push("/login"); return; }
      if (!response.ok) {
        setRetryError({ crewId, text: "Couldn't retry setup. Check the desktop service, then try again." });
        return;
      }
      await refresh();
      router.refresh();
    } catch {
      setRetryError({ crewId, text: "Unable to connect. Try again." });
    } finally {
      setRetrying(null);
    }
  }

  function setMember(index: number, change: Partial<MemberDraft>) {
    setMembers((current) => current.map((member, position) => position === index ? { ...member, ...change } : member));
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const trimmedName = name.trim();
    if (!trimmedName) { setError("Give the crew a name."); return; }
    const names = members.map((member) => member.name.trim().toLowerCase()).filter(Boolean);
    if (names.length !== members.length || new Set(names).size !== names.length) {
      setError("Each member needs a unique name.");
      return;
    }
    for (const member of members) {
      const problem = memberError(member);
      if (problem) { setError(problem); return; }
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/crews", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({
          name: trimmedName,
          description: description.trim(),
          members: members.map((member) => ({
            name: member.name.trim(),
            role: member.role.trim(),
            ...(member.soulMd.trim() ? { soulMd: member.soulMd.trim() } : {}),
            avatarVariant: member.avatarVariant,
            ...(member.dailyBudgetUsd.trim() ? { dailyBudgetUsd: member.dailyBudgetUsd.trim() } : {}),
            ...(member.monthlyBudgetUsd.trim() ? { monthlyBudgetUsd: member.monthlyBudgetUsd.trim() } : {}),
          })),
        }),
      });
      if (response.status === 401) { router.push("/login"); return; }
      if (!response.ok) {
        setError("Couldn't create this crew. Check names, roles and budgets, then try again.");
        return;
      }
      setCreating(false);
      setName("");
      setDescription("");
      setMembers([blankMember()]);
      await refresh();
      router.refresh();
    } catch {
      setError("Unable to connect. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="custom-crews-heading" className="rounded-lg border border-border bg-card p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="custom-crews-heading" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <UsersRound aria-hidden="true" className="size-4 text-muted-foreground" />Crews
          </h2>
          <p className="mt-1 max-w-[80ch] text-sm text-muted-foreground">
            A named group of up to 6 agents that hand off to each other. Only the crew name and each
            member&apos;s name and role are required — persona, budgets, tools and actions fill from safe
            defaults. Handoffs stay inside the crew; agents outside it can&apos;t be handed work.
          </p>
        </div>
        <Button type="button" onClick={() => { setError(null); setCreating(true); }}>
          <Plus aria-hidden="true" className="size-4" />New crew
        </Button>
      </div>

      <div className="mt-5">
        {crews === null ? (
          loadError
            ? <p role="alert" className="text-sm text-danger">Crews could not be loaded. <button type="button" onClick={() => void refresh()} className="underline underline-offset-4">Try again</button>.</p>
            : <p role="status" className="text-sm text-muted-foreground">Loading crews…</p>
        ) : crews.length === 0 ? (
          <p className="text-sm text-muted-foreground">No crews yet. Create one to group agents that work together.</p>
        ) : (
          <ul className="flex flex-col gap-3" aria-label="Custom crews">
            {crews.map((crew) => (
              <li key={crew.id} className="rounded-md border border-border p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-semibold">{crew.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {crew.summary.ready} of {crew.summary.total} ready
                    {crew.summary.failed > 0 ? ` · ${crew.summary.failed} failed` : ""}
                    {crew.summary.inProgress > 0 ? " · working…" : ""}
                  </p>
                </div>
                {crew.description ? <p className="mt-1 text-xs text-muted-foreground">{crew.description}</p> : null}
                {crew.retryable && (
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <Button type="button" variant="secondary" size="sm" disabled={retrying !== null} onClick={() => void retry(crew.id)}>
                      {retrying === crew.id && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
                      Retry failed setup
                    </Button>
                    <p className="text-xs text-muted-foreground">A retry reuses the same agents.</p>
                  </div>
                )}
                {retryError?.crewId === crew.id && <p role="alert" className="mt-2 text-sm text-danger">{retryError.text}</p>}
                <ul className="mt-2 grid gap-2 md:grid-cols-2" aria-label={`${crew.name} members`}>
                  {crew.members.map((member) => (
                    <li key={member.memberId} className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2">
                      <div className="min-w-0">
                        {member.agentName ? (
                          <Link href={`/?agent=${member.agentId}`} className="block truncate text-sm hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                            {member.agentName}
                          </Link>
                        ) : (
                          <p className="truncate text-sm text-muted-foreground">Setting up…</p>
                        )}
                        <p className="truncate text-xs text-muted-foreground">{member.role}</p>
                        {member.state === "failed" && (
                          <p className="mt-1 text-xs text-corona">
                            Setup stopped: {member.errorCode === "agent_create_failed" ? "the agent record could not be created. Retry is safe." : "the desktop did not start. The paused agent is kept; Retry resumes it."}
                          </p>
                        )}
                      </div>
                      <CrewMemberState state={member.state} />
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>

      {creating && (
        <ModalDialog title="New crew" description="Up to 6 agents. Handoffs stay inside this crew."
          onClose={() => setCreating(false)}>
          <form onSubmit={save} className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
            <div className="flex flex-col gap-2">
              <label htmlFor="crew-name" className="text-sm font-medium">Crew name</label>
              <input id="crew-name" value={name} onChange={(event) => setName(event.target.value)}
                required maxLength={80} autoComplete="off" placeholder="Market watch"
                className="h-8 rounded-md border border-input bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="crew-description" className="text-sm font-medium">Description <span className="text-muted-foreground">(optional)</span></label>
              <input id="crew-description" value={description} onChange={(event) => setDescription(event.target.value)}
                maxLength={500} autoComplete="off" placeholder="Who this crew watches and why"
                className="h-8 rounded-md border border-input bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium">Members <span className="font-normal text-muted-foreground">({members.length} of 6)</span></p>
              {members.map((member, index) => (
                <fieldset key={index} className="flex flex-col gap-2 rounded-md border border-border p-3">
                  <legend className="px-1 text-xs text-muted-foreground">Agent {index + 1}</legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="flex flex-col gap-1 text-xs font-medium">Name
                      <input value={member.name} onChange={(event) => setMember(index, { name: event.target.value })}
                        required maxLength={80} autoComplete="off" placeholder="Milly"
                        className="h-8 rounded-md border border-input bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-medium">Role / specialty
                      <input value={member.role} onChange={(event) => setMember(index, { role: event.target.value })}
                        required maxLength={80} autoComplete="off" placeholder="Competitive researcher"
                        className="h-8 rounded-md border border-input bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                    </label>
                  </div>
                  <div className="flex items-center gap-2">
                    <AgentAvatar seed={member.name.trim() || `member-${index}`} variant={member.avatarVariant} size={32} label={`Avatar ${member.avatarVariant + 1} of ${AVATAR_COUNT}`} />
                    <p aria-live="polite" className="min-w-0 flex-1 text-xs text-muted-foreground">Avatar {member.avatarVariant + 1} of {AVATAR_COUNT}</p>
                    <Button type="button" variant="secondary" size="sm" aria-label={`Shuffle avatar for ${member.name.trim() || `agent ${index + 1}`}`}
                      onClick={() => setMember(index, { avatarVariant: randomAvatarVariant(member.avatarVariant) })}>
                      <Shuffle aria-hidden="true" className="size-4" />Shuffle
                    </Button>
                  </div>
                  <label className="flex flex-col gap-1 text-xs font-medium">Persona <span className="font-normal text-muted-foreground">(optional — defaults to the role)</span>
                    <textarea value={member.soulMd} onChange={(event) => setMember(index, { soulMd: event.target.value })}
                      maxLength={2000} rows={2} placeholder="How this agent talks and behaves"
                      className="rounded-md border border-input bg-surface px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-ring" />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex flex-col gap-1 text-xs font-medium">Daily budget USD <span className="font-normal text-muted-foreground">(optional, $5)</span>
                      <input value={member.dailyBudgetUsd} onChange={(event) => setMember(index, { dailyBudgetUsd: event.target.value })}
                        inputMode="decimal" maxLength={10} autoComplete="off" placeholder="5.00"
                        className="h-8 rounded-md border border-input bg-surface px-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-ring" />
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-medium">Monthly budget USD <span className="font-normal text-muted-foreground">(optional, $50)</span>
                      <input value={member.monthlyBudgetUsd} onChange={(event) => setMember(index, { monthlyBudgetUsd: event.target.value })}
                        inputMode="decimal" maxLength={10} autoComplete="off" placeholder="50.00"
                        className="h-8 rounded-md border border-input bg-surface px-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-ring" />
                    </label>
                  </div>
                  {members.length > 1 && (
                    <div>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setMembers((current) => current.filter((_, position) => position !== index))}>
                        <Trash2 aria-hidden="true" className="size-4" />Remove
                      </Button>
                    </div>
                  )}
                </fieldset>
              ))}
              {members.length < 6 && (
                <div>
                  <Button type="button" variant="secondary" size="sm" onClick={() => setMembers((current) => [...current, blankMember()])}>
                    <Plus aria-hidden="true" className="size-4" />Add member
                  </Button>
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground">Tools and actions are assigned automatically (read and deliver files, desktop, handoff). Domains start empty — add them per agent in Settings.</p>
            {error && <p role="alert" className="text-sm text-danger">{error}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setCreating(false)}>Cancel</Button>
              <Button type="submit" disabled={saving}>
                {saving && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}Create crew
              </Button>
            </div>
          </form>
        </ModalDialog>
      )}
    </section>
  );
}

function CrewMemberState({ state }: { state: CrewView["members"][number]["state"] }) {
  if (state === "ready") return <span className="inline-flex shrink-0 items-center gap-1 text-xs text-success"><CheckCircle2 aria-hidden="true" className="size-3.5" />Ready</span>;
  if (state === "failed") return <span className="inline-flex shrink-0 items-center gap-1 text-xs text-corona"><CircleAlert aria-hidden="true" className="size-3.5" />Retry</span>;
  return <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground")}><LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />{state === "creating" ? "Creating" : "Queued"}</span>;
}
