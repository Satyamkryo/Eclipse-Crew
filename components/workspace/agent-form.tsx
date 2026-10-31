"use client";
import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export type AgentFormInitial = {
  name: string;
  role: string;
  soulMd: string;
  dailyBudgetCents: number;
  monthlyBudgetCents: number;
  tools: string[];
  domains: string[];
  actions: string[];
  memoryScopes: string[];
};

type Props = {
  mode: "create" | "edit";
  agentId?: string;
  csrfToken: string;
  initial?: AgentFormInitial;
  onSaved: (agentId?: string) => void;
  onCancel?: () => void;
};

const inputClass = "h-8 w-full min-w-0 rounded-md border border-input bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";
const textareaClass = "min-h-20 w-full rounded-md border border-input bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";
const scopes = ["global", "agent", "private"] as const;

function listText(values: string[]) { return values.join(", "); }
function parseList(value: FormDataEntryValue | null) {
  return String(value ?? "").split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
}
function money(cents: number) { return (cents / 100).toFixed(2); }
function messageFor(code?: string) {
  if (code === "invalid_input") return "Check the highlighted settings and try again.";
  if (code === "desktop_setup_failed") return "The agent was saved, but its desktop couldn't start. Use Resume to retry.";
  if (code === "agent_not_found") return "This agent no longer exists. Refresh the workspace.";
  return "Couldn't save the agent. Try again.";
}

export function AgentForm({ mode, agentId, csrfToken, initial, onSaved, onCancel }: Props) {
  const router = useRouter();
  const errorRef = useRef<HTMLParagraphElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [memoryScopes, setMemoryScopes] = useState<string[]>(initial?.memoryScopes ?? []);
  const prefix = mode === "create" ? "new-agent" : "agent-settings";

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading || !event.currentTarget.reportValidity()) return;
    setLoading(true);
    setError(null);
    setStatus(null);
    const form = new FormData(event.currentTarget);
    const payload = {
      name: form.get("name"),
      role: form.get("role"),
      ...(mode === "create" && !String(form.get("soulMd") ?? "").trim() ? {} : { soulMd: form.get("soulMd") }),
      dailyBudgetUsd: String(form.get("dailyBudgetUsd")),
      monthlyBudgetUsd: String(form.get("monthlyBudgetUsd")),
      tools: parseList(form.get("tools")),
      domains: parseList(form.get("domains")),
      actions: parseList(form.get("actions")),
      memoryScopes,
    };
    try {
      const response = await fetch(mode === "create" ? "/api/agents" : `/api/agents/${agentId}`, {
        method: mode === "create" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(payload),
      });
      if (response.status === 401) {
        router.push("/login");
        router.refresh();
        return;
      }
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(messageFor(result.error));
        return;
      }
      setStatus(mode === "create" ? "Agent created." : "Agent settings saved.");
      onSaved(result.agentId);
      router.refresh();
    } catch {
      setError("Unable to connect. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${prefix}-name`} label="Name">
          <input id={`${prefix}-name`} name="name" required maxLength={80} defaultValue={initial?.name ?? ""}
            aria-describedby={error ? `${prefix}-error` : undefined} className={inputClass} />
        </Field>
        <Field id={`${prefix}-role`} label="Role">
          <input id={`${prefix}-role`} name="role" required maxLength={80} defaultValue={initial?.role ?? ""}
            aria-describedby={error ? `${prefix}-error` : undefined} className={inputClass} />
        </Field>
      </div>
      <Field id={`${prefix}-soul`} label="Persona (SOUL.md)" hint="Identity, role, tone and boundaries. Up to 2,000 characters. Leave blank on create for a role-based default.">
        <textarea id={`${prefix}-soul`} name="soulMd" required={mode === "edit"} maxLength={2000} rows={6} defaultValue={initial?.soulMd ?? ""}
          aria-describedby={`${prefix}-soul-hint${error ? ` ${prefix}-error` : ""}`} className={textareaClass} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${prefix}-daily-budget`} label="Daily budget (USD)">
          <input id={`${prefix}-daily-budget`} name="dailyBudgetUsd" type="number" inputMode="decimal" required
            min="0.01" max="1000000" step="0.01" defaultValue={initial ? money(initial.dailyBudgetCents) : ""}
            className={inputClass} />
        </Field>
        <Field id={`${prefix}-monthly-budget`} label="Monthly budget (USD)">
          <input id={`${prefix}-monthly-budget`} name="monthlyBudgetUsd" type="number" inputMode="decimal" required
            min="0.01" max="1000000" step="0.01" defaultValue={initial ? money(initial.monthlyBudgetCents) : ""}
            className={inputClass} />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${prefix}-tools`} label="Tools" hint="Comma-separated identifiers. Empty denies every tool.">
          <textarea id={`${prefix}-tools`} name="tools" rows={2} defaultValue={initial ? listText(initial.tools) : ""}
            aria-describedby={`${prefix}-tools-hint`} className={textareaClass} />
        </Field>
        <Field id={`${prefix}-domains`} label="Domains" hint="Comma-separated hostnames, for example example.com. Empty denies every site.">
          <textarea id={`${prefix}-domains`} name="domains" rows={2} defaultValue={initial ? listText(initial.domains) : ""}
            aria-describedby={`${prefix}-domains-hint`} className={textareaClass} />
        </Field>
      </div>
      <Field id={`${prefix}-actions`} label="Actions" hint="Comma-separated action types. Empty denies every action.">
        <textarea id={`${prefix}-actions`} name="actions" rows={2} defaultValue={initial ? listText(initial.actions) : ""}
          aria-describedby={`${prefix}-actions-hint`} className={textareaClass} />
      </Field>
      <fieldset>
        <legend className="text-sm font-medium">Memory scopes</legend>
        <p className="mt-1 text-xs text-muted-foreground">No scope selected denies memory access.</p>
        <div className="mt-2 flex flex-wrap gap-4">
          {scopes.map((scope) => (
            <label key={scope} className="flex items-center gap-2 text-sm capitalize">
              <input type="checkbox" checked={memoryScopes.includes(scope)}
                onChange={(event) => setMemoryScopes((current) => event.target.checked
                  ? [...current, scope] : current.filter((item) => item !== scope))}
                className="size-4 rounded border-input" />
              {scope}
            </label>
          ))}
        </div>
      </fieldset>
      {error && <p ref={errorRef} id={`${prefix}-error`} role="alert" tabIndex={-1} className="text-sm text-danger">{error}</p>}
      {status && <p role="status" className="text-sm text-success">{status}</p>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {onCancel && <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" disabled={loading}>
          {loading && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
          {mode === "create" ? "Create agent" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      {children}
      {hint && <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
