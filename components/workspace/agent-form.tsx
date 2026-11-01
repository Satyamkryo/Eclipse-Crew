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
  if (code === "invalid_input") return "One or more settings were rejected. Review the values.";
  if (code === "desktop_setup_failed") return "The agent was saved, but its desktop couldn't start. Use Resume to retry.";
  if (code === "agent_not_found") return "This agent no longer exists. Refresh the workspace.";
  return "Couldn't save the agent. Try again.";
}

const fields = ["name", "role", "soulMd", "dailyBudgetUsd", "monthlyBudgetUsd", "tools", "domains", "actions"] as const;
type FieldName = typeof fields[number];
type FieldErrors = Partial<Record<FieldName, string>>;
const fieldIds: Record<FieldName, string> = {
  name: "name", role: "role", soulMd: "soul", dailyBudgetUsd: "daily-budget",
  monthlyBudgetUsd: "monthly-budget", tools: "tools", domains: "domains", actions: "actions",
};
const budgetMessage = (label: string) => `Enter a ${label} budget from 0.01 to 1,000,000.00.`;
const tokenPattern = /^[a-z0-9][a-z0-9._:-]*$/;
const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function validateField(name: FieldName, raw: string, mode: "create" | "edit"): string | undefined {
  const value = raw.trim();
  if (name === "name" || name === "role") {
    const label = name === "name" ? "Name" : "Role";
    if (!value) return `${label} is required.`;
    if (value.length > 80) return `${label} must be 80 characters or fewer.`;
    if (/[\x00-\x1f\x7f]/.test(value)) return `${label} must be a single line without control characters.`;
  }
  if (name === "soulMd") {
    if (mode === "edit" && !value) return "Persona is required when editing.";
    if (value.length > 2000) return "Persona must be 2,000 characters or fewer.";
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return "Persona contains unsupported control characters.";
  }
  if (name === "dailyBudgetUsd" || name === "monthlyBudgetUsd") {
    const label = name === "dailyBudgetUsd" ? "daily" : "monthly";
    if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(value)) return budgetMessage(label);
    const cents = Number(value.split(".")[0]) * 100 + Number((value.split(".")[1] ?? "").padEnd(2, "0"));
    if (cents < 1 || cents > 100_000_000) return budgetMessage(label);
  }
  if (name === "tools" || name === "actions") {
    const items = parseList(value);
    if (items.length > 64) return "Use no more than 64 entries.";
    if (items.some((item) => item.length > 64)) return "Each identifier must be 64 characters or fewer.";
    if (!items.every((item) => tokenPattern.test(item.toLowerCase()))) return "Use identifiers such as web.fetch.";
  }
  if (name === "domains") {
    const items = parseList(value);
    if (items.length > 64) return "Use no more than 64 domains.";
    if (items.some((item) => item.length > 253)) return "Each domain must be 253 characters or fewer.";
    if (!items.every((item) => domainPattern.test(item.toLowerCase()))) return "Domains must be hostnames such as example.com.";
  }
  return undefined;
}

export function AgentForm({ mode, agentId, csrfToken, initial, onSaved, onCancel }: Props) {
  const router = useRouter();
  const errorRef = useRef<HTMLParagraphElement>(null);
  const focusInvalid = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [memoryScopes, setMemoryScopes] = useState<string[]>(initial?.memoryScopes ?? []);
  const prefix = mode === "create" ? "new-agent" : "agent-settings";

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  useEffect(() => {
    if (!focusInvalid.current) return;
    focusInvalid.current = false;
    const first = fields.find((field) => errors[field]);
    if (first) document.getElementById(`${prefix}-${fieldIds[first]}`)?.focus();
  }, [errors, prefix]);

  function validateOne(name: FieldName, value: string) {
    setErrors((current) => {
      const next = { ...current };
      const message = validateField(name, value, mode);
      if (message) next[name] = message;
      else delete next[name];
      return next;
    });
  }

  function validateOnBlur(event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>, name: FieldName) {
    if (event.relatedTarget instanceof HTMLButtonElement && event.relatedTarget.type === "submit") return;
    validateOne(name, event.currentTarget.value);
  }

  function validateAll(values: Record<FieldName, string>) {
    const next: FieldErrors = {};
    for (const field of fields) {
      const message = validateField(field, values[field], mode);
      if (message) next[field] = message;
    }
    setErrors(next);
    if (fields.some((field) => next[field])) {
      focusInvalid.current = true;
      return false;
    }
    return true;
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    const form = new FormData(event.currentTarget);
    const values = Object.fromEntries(fields.map((field) => [field, String(form.get(field) ?? "")])) as Record<FieldName, string>;
    if (!validateAll(values)) return;
    setLoading(true);
    setError(null);
    setStatus(null);
    const payload = {
      name: values.name,
      role: values.role,
      ...(mode === "create" && !values.soulMd.trim() ? {} : { soulMd: values.soulMd }),
      dailyBudgetUsd: values.dailyBudgetUsd,
      monthlyBudgetUsd: values.monthlyBudgetUsd,
      tools: parseList(values.tools),
      domains: parseList(values.domains),
      actions: parseList(values.actions),
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
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${prefix}-name`} label="Name" error={errors.name}>
          <input id={`${prefix}-name`} name="name" required maxLength={80} defaultValue={initial?.name ?? ""}
            onBlur={(event) => validateOnBlur(event, "name")}
            aria-invalid={errors.name ? true : undefined} aria-describedby={errors.name ? `${prefix}-name-error` : undefined}
            className={inputClass} />
        </Field>
        <Field id={`${prefix}-role`} label="Role" error={errors.role}>
          <input id={`${prefix}-role`} name="role" required maxLength={80} defaultValue={initial?.role ?? ""}
            onBlur={(event) => validateOnBlur(event, "role")}
            aria-invalid={errors.role ? true : undefined} aria-describedby={errors.role ? `${prefix}-role-error` : undefined}
            className={inputClass} />
        </Field>
      </div>
      <Field id={`${prefix}-soul`} label="Persona (SOUL.md)" error={errors.soulMd} hint="Identity, role, tone and boundaries. Up to 2,000 characters. Leave blank on create for a role-based default.">
        <textarea id={`${prefix}-soul`} name="soulMd" required={mode === "edit"} maxLength={2000} rows={6} defaultValue={initial?.soulMd ?? ""}
          onBlur={(event) => validateOnBlur(event, "soulMd")}
          aria-invalid={errors.soulMd ? true : undefined}
          aria-describedby={`${prefix}-soul-hint${errors.soulMd ? ` ${prefix}-soul-error` : ""}`} className={textareaClass} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${prefix}-daily-budget`} label="Daily budget (USD)" error={errors.dailyBudgetUsd}>
          <input id={`${prefix}-daily-budget`} name="dailyBudgetUsd" type="number" inputMode="decimal" required
            min="0.01" max="1000000" step="0.01" defaultValue={initial ? money(initial.dailyBudgetCents) : ""}
            onBlur={(event) => validateOnBlur(event, "dailyBudgetUsd")}
            aria-invalid={errors.dailyBudgetUsd ? true : undefined}
            aria-describedby={errors.dailyBudgetUsd ? `${prefix}-daily-budget-error` : undefined}
            className={inputClass} />
        </Field>
        <Field id={`${prefix}-monthly-budget`} label="Monthly budget (USD)" error={errors.monthlyBudgetUsd}>
          <input id={`${prefix}-monthly-budget`} name="monthlyBudgetUsd" type="number" inputMode="decimal" required
            min="0.01" max="1000000" step="0.01" defaultValue={initial ? money(initial.monthlyBudgetCents) : ""}
            onBlur={(event) => validateOnBlur(event, "monthlyBudgetUsd")}
            aria-invalid={errors.monthlyBudgetUsd ? true : undefined}
            aria-describedby={errors.monthlyBudgetUsd ? `${prefix}-monthly-budget-error` : undefined}
            className={inputClass} />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${prefix}-tools`} label="Tools" error={errors.tools} hint="Comma-separated identifiers. Empty denies every tool.">
          <textarea id={`${prefix}-tools`} name="tools" rows={2} defaultValue={initial ? listText(initial.tools) : ""}
            onBlur={(event) => validateOnBlur(event, "tools")}
            aria-invalid={errors.tools ? true : undefined}
            aria-describedby={`${prefix}-tools-hint${errors.tools ? ` ${prefix}-tools-error` : ""}`} className={textareaClass} />
        </Field>
        <Field id={`${prefix}-domains`} label="Domains" error={errors.domains} hint="Comma-separated hostnames, for example example.com. Empty denies every site.">
          <textarea id={`${prefix}-domains`} name="domains" rows={2} defaultValue={initial ? listText(initial.domains) : ""}
            onBlur={(event) => validateOnBlur(event, "domains")}
            aria-invalid={errors.domains ? true : undefined}
            aria-describedby={`${prefix}-domains-hint${errors.domains ? ` ${prefix}-domains-error` : ""}`} className={textareaClass} />
        </Field>
      </div>
      <Field id={`${prefix}-actions`} label="Actions" error={errors.actions} hint="Comma-separated action types. Empty denies every action.">
        <textarea id={`${prefix}-actions`} name="actions" rows={2} defaultValue={initial ? listText(initial.actions) : ""}
          onBlur={(event) => validateOnBlur(event, "actions")}
          aria-invalid={errors.actions ? true : undefined}
          aria-describedby={`${prefix}-actions-hint${errors.actions ? ` ${prefix}-actions-error` : ""}`} className={textareaClass} />
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

function Field({ id, label, hint, error, children }: {
  id: string; label: string; hint?: string; error?: string; children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      {children}
      {hint && <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p id={`${id}-error`} className="text-sm text-danger">{error}</p>}
    </div>
  );
}
