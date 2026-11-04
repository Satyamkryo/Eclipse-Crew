"use client";
import { KNOWN_ACTIONS, SUBAGENT_HINT } from "@/lib/agents/actions";
import { AGENT_TEMPLATES, type AgentTemplateId } from "@/lib/agents/templates";
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, LoaderCircle, Shuffle, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { AgentAvatar, AVATAR_COUNT, randomAvatarVariant } from "@/components/workspace/agent-avatar";
import { cn } from "@/lib/utils";

export type AgentFormInitial = {
  name: string;
  role: string;
  instructions?: string;
  soulMd: string;
  dailyBudgetCents: number;
  monthlyBudgetCents: number;
  tools: string[];
  domains: string[];
  anyPublicWeb?: boolean;
  actions: string[];
  memoryScopes: string[];
  avatarVariant?: number;
};

type Props = {
  mode: "create" | "edit";
  agentId?: string;
  csrfToken: string;
  initial?: AgentFormInitial;
  // Gallery template cards preselect a template; the form behaves exactly as if
  // the owner had picked it from the Start-from chips. Unknown ids are ignored.
  initialTemplate?: AgentTemplateId | null;
  onSaved: (agentId?: string) => void;
  onCancel?: () => void;
};

const inputClass = "h-8 w-full min-w-0 rounded-md border border-input bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";
const textareaClass = "min-h-20 w-full rounded-md border border-input bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";
const scopes = ["global", "agent", "private"] as const;
const DEFAULT_SCOPES = ["global", "agent"];

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

const fields = ["name", "role", "instructions", "soulMd", "dailyBudgetUsd", "monthlyBudgetUsd", "tools", "domains", "actions"] as const;
type FieldName = typeof fields[number];
type FieldErrors = Partial<Record<FieldName, string>>;
const ADVANCED_FIELDS: FieldName[] = ["dailyBudgetUsd", "monthlyBudgetUsd", "tools", "domains", "actions"];
const fieldIds: Record<FieldName, string> = {
  name: "name", role: "role", instructions: "instructions", soulMd: "persona", dailyBudgetUsd: "daily-budget",
  monthlyBudgetUsd: "monthly-budget", tools: "tools", domains: "domains", actions: "actions",
};
const budgetMessage = (label: string) => `Enter a ${label} budget from 0.01 to 1,000,000.00, or leave it blank for the default.`;
const tokenPattern = /^[a-z0-9][a-z0-9._:-]*$/;
const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function validateField(name: FieldName, raw: string, onlyListedSites: boolean): string | undefined {
  const value = raw.trim();
  if (name === "name" || name === "role") {
    const label = name === "name" ? "Name" : "Role";
    if (!value) return `${label} is required.`;
    if (value.length > 80) return `${label} must be 80 characters or fewer.`;
    if (/[\x00-\x1f\x7f]/.test(value)) return `${label} must be a single line without control characters.`;
  }
  if (name === "instructions" || name === "soulMd") {
    const label = name === "instructions" ? "Instructions" : "Persona";
    const max = name === "instructions" ? 4000 : 2000;
    if (value.length > max) return `${label} must be ${max.toLocaleString("en")} characters or fewer.`;
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return `${label} contains unsupported control characters.`;
  }
  if ((name === "dailyBudgetUsd" || name === "monthlyBudgetUsd") && value) {
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
    if (onlyListedSites && items.length === 0) return "Add at least one site, or choose Any public website.";
    if (items.length > 64) return "Use no more than 64 sites.";
    if (items.some((item) => item.length > 253)) return "Each site must be 253 characters or fewer.";
    if (!items.every((item) => domainPattern.test(item.toLowerCase()))) return "Sites must be hostnames such as example.com.";
  }
  return undefined;
}

// Name and role are the only required fields. Instructions and Persona are optional, and everything else sits under
// Advanced with safe defaults: $5/$50 budgets, any public website, no MCP tools, the standard actions, and USER.md +
// the agent's own MEMORY.md.
export function AgentForm({ mode, agentId, csrfToken, initial, initialTemplate, onSaved, onCancel }: Props) {
  const router = useRouter();
  const preset = mode === "create" && initialTemplate ? AGENT_TEMPLATES.find((item) => item.id === initialTemplate) : undefined;
  const errorRef = useRef<HTMLParagraphElement>(null);
  const focusInvalid = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [memoryScopes, setMemoryScopes] = useState<string[]>(initial?.memoryScopes ?? preset?.memoryScopes ?? DEFAULT_SCOPES);
  const [anyPublicWeb, setAnyPublicWeb] = useState<boolean>(initial?.anyPublicWeb ?? (preset ? preset.domains.length === 0 : true));
  const [avatarVariant, setAvatarVariant] = useState<number>(() =>
    initial?.avatarVariant !== undefined && Number.isInteger(initial.avatarVariant) &&
    initial.avatarVariant >= 0 && initial.avatarVariant < AVATAR_COUNT
      ? initial.avatarVariant
      : randomAvatarVariant());
  // Edit mode: the avatar last saved on the server, so a shuffle can be saved or undone right next to the preview.
  const [savedAvatarVariant, setSavedAvatarVariant] = useState(avatarVariant);
  const avatarUnsaved = mode === "edit" && avatarVariant !== savedAvatarVariant;
  const [avatarStatus, setAvatarStatus] = useState<string | null>(null);
  const [template, setTemplate] = useState<AgentTemplateId | "blank">(preset?.id ?? "blank");
  const [templateMessage, setTemplateMessage] = useState<string | null>(
    preset ? `Template applied: ${preset.label}. Review the fields before saving.` : null);
  const formRef = useRef<HTMLFormElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
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

  function applyTemplate(id: AgentTemplateId | "blank") {
    const selected = id === "blank" ? undefined : AGENT_TEMPLATES.find((item) => item.id === id);
    const form = formRef.current;
    setTemplate(id);
    setErrors({});
    setError(null);
    if (form) {
      const set = (name: string, value: string) => {
        const field = form.elements.namedItem(name);
        if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) field.value = value;
      };
      set("role", selected?.role ?? "");
      set("instructions", selected?.instructions ?? "");
      set("dailyBudgetUsd", selected?.dailyBudgetUsd ?? "");
      set("monthlyBudgetUsd", selected?.monthlyBudgetUsd ?? "");
      set("tools", (selected?.tools ?? []).join(", "));
      set("domains", (selected?.domains ?? []).join(", "));
      set("actions", (selected?.actions ?? KNOWN_ACTIONS).join(", "));
    }
    // A template that lists its own sites keeps to them; Blank goes back to any public website.
    setAnyPublicWeb(!selected || selected.domains.length === 0);
    setMemoryScopes(selected?.memoryScopes ?? DEFAULT_SCOPES);
    setTemplateMessage(selected ? `Template applied: ${selected.label}. Review the fields before saving.` : "Blank agent. Add a name and role.");
    requestAnimationFrame(() => statusRef.current?.focus());
  }

  function validateOne(name: FieldName, value: string) {
    setErrors((current) => {
      const next = { ...current };
      const message = validateField(name, value, !anyPublicWeb);
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
      const message = validateField(field, values[field], !anyPublicWeb);
      if (message) next[field] = message;
    }
    setErrors(next);
    if (fields.some((field) => next[field])) {
      // A problem inside Advanced opens it, so the focused field is visible.
      if (ADVANCED_FIELDS.some((field) => next[field])) setAdvancedOpen(true);
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
    // Blank optional values are left out, so the server applies its defaults.
    const payload = {
      name: values.name,
      role: values.role,
      instructions: values.instructions.trim(),
      soulMd: values.soulMd.trim(),
      avatarVariant,
      ...(values.dailyBudgetUsd.trim() ? { dailyBudgetUsd: values.dailyBudgetUsd.trim() } : {}),
      ...(values.monthlyBudgetUsd.trim() ? { monthlyBudgetUsd: values.monthlyBudgetUsd.trim() } : {}),
      tools: parseList(values.tools),
      anyPublicWeb,
      domains: parseList(values.domains),
      actions: parseList(values.actions),
      memoryScopes: memoryScopes.length ? memoryScopes : DEFAULT_SCOPES,
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
      if (mode === "edit" && avatarVariant !== savedAvatarVariant) setAvatarStatus("Avatar saved.");
      setSavedAvatarVariant(avatarVariant);
      onSaved(result.agentId);
      router.refresh();
    } catch {
      setError("Unable to connect. Try again.");
    } finally {
      setLoading(false);
    }
  }

  const advancedId = `${prefix}-advanced`;
  const advancedErrors = ADVANCED_FIELDS.filter((field) => errors[field]).length;

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <AgentAvatar seed={mode === "edit" && agentId ? agentId : "new-agent"} variant={avatarVariant} size={40} label={`Avatar ${avatarVariant + 1} of ${AVATAR_COUNT}`} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Avatar</p>
          <p aria-live="polite" className="text-xs text-muted-foreground">
            Avatar {avatarVariant + 1} of {AVATAR_COUNT}{avatarUnsaved ? " · not saved yet" : mode === "create" ? ", picked at random" : ""}.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {avatarUnsaved && (
            <Button type="button" variant="ghost" size="sm" disabled={loading}
              onClick={() => setAvatarVariant(savedAvatarVariant)}>
              <Undo2 aria-hidden="true" className="size-4" />Undo
            </Button>
          )}
          <Button type="button" variant="secondary" size="sm" aria-label="Shuffle avatar"
            onClick={() => { setAvatarStatus(null); setAvatarVariant((current) => randomAvatarVariant(current)); }}>
            <Shuffle aria-hidden="true" className="size-4" />Shuffle
          </Button>
          {avatarUnsaved && (
            <Button type="button" size="sm" disabled={loading} onClick={() => formRef.current?.requestSubmit()}>
              {loading ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> : <Check aria-hidden="true" className="size-4" />}
              Save avatar
            </Button>
          )}
        </div>
      </div>
      {avatarStatus && <p role="status" className="-mt-3 text-xs text-success">{avatarStatus}</p>}
      {mode === "create" && (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Start from <span className="font-normal text-muted-foreground">(optional)</span></span>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Agent template">
            {[{ id: "blank" as const, label: "Blank" }, ...AGENT_TEMPLATES.map((item) => ({ id: item.id, label: item.label }))].map((item) => (
              <Button key={item.id} type="button" variant="secondary" size="sm" aria-pressed={template === item.id}
                className={cn(template === item.id && "bg-accent")} onClick={() => applyTemplate(item.id)}>
                {item.label}
              </Button>
            ))}
          </div>
          {template !== "blank" && (
            <p className="text-xs text-muted-foreground">{AGENT_TEMPLATES.find((item) => item.id === template)?.description}</p>
          )}
          {templateMessage && (
            <p ref={statusRef} role="status" aria-live="polite" tabIndex={-1} className="text-sm text-success">{templateMessage}</p>
          )}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${prefix}-name`} label="Name" error={errors.name}>
          <input id={`${prefix}-name`} name="name" required maxLength={80} defaultValue={initial?.name ?? ""}
            onBlur={(event) => validateOnBlur(event, "name")}
            aria-invalid={errors.name ? true : undefined} aria-describedby={errors.name ? `${prefix}-name-error` : undefined}
            className={inputClass} />
        </Field>
        <Field id={`${prefix}-role`} label="Role" error={errors.role} hint="For example: Travel researcher, Inbox assistant.">
          <input id={`${prefix}-role`} name="role" required maxLength={80} defaultValue={initial?.role ?? preset?.role ?? ""}
            onBlur={(event) => validateOnBlur(event, "role")}
            aria-invalid={errors.role ? true : undefined}
            aria-describedby={`${prefix}-role-hint${errors.role ? ` ${prefix}-role-error` : ""}`}
            className={inputClass} />
        </Field>
      </div>
      <Field id={`${prefix}-instructions`} label="Instructions" optional error={errors.instructions}
        hint="What this agent is expert in and how it should work. The agent treats it as its specialty and works thoroughly. Leave blank for an expert default based on the role.">
        <textarea id={`${prefix}-instructions`} name="instructions" maxLength={4000} rows={5} defaultValue={initial?.instructions ?? preset?.instructions ?? ""}
          onBlur={(event) => validateOnBlur(event, "instructions")}
          aria-invalid={errors.instructions ? true : undefined}
          aria-describedby={`${prefix}-instructions-hint${errors.instructions ? ` ${prefix}-instructions-error` : ""}`} className={textareaClass} />
      </Field>
      <Field id={`${prefix}-persona`} label="Persona" optional error={errors.soulMd}
        hint="Who the agent is: a backstory, a personality, how it talks and behaves. It never changes what the agent is allowed to do.">
        <textarea id={`${prefix}-persona`} name="soulMd" maxLength={2000} rows={3} defaultValue={initial?.soulMd ?? ""}
          onBlur={(event) => validateOnBlur(event, "soulMd")}
          aria-invalid={errors.soulMd ? true : undefined}
          aria-describedby={`${prefix}-persona-hint${errors.soulMd ? ` ${prefix}-persona-error` : ""}`} className={textareaClass} />
      </Field>

      <div className="rounded-lg border border-border">
        <button type="button" aria-expanded={advancedOpen} aria-controls={advancedId} onClick={() => setAdvancedOpen((open) => !open)}
          className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors duration-150 hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-ring">
          <span className="min-w-0">
            Advanced
            <span className="ml-2 font-normal text-muted-foreground">
              {advancedErrors > 0 ? `${advancedErrors} to fix` : "Budgets, websites, tools, actions, memory"}
            </span>
          </span>
          <ChevronDown aria-hidden="true" className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-150", advancedOpen && "rotate-180")} />
        </button>
        {/* Kept in the DOM when closed so its values are still submitted. */}
        <div id={advancedId} hidden={!advancedOpen} className="flex flex-col gap-5 border-t border-border p-3">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={`${prefix}-daily-budget`} label="Daily budget (USD)" optional error={errors.dailyBudgetUsd} hint="Blank uses $5.00.">
              <input id={`${prefix}-daily-budget`} name="dailyBudgetUsd" type="number" inputMode="decimal" placeholder="5.00"
                min="0.01" max="1000000" step="0.01" defaultValue={initial ? money(initial.dailyBudgetCents) : preset?.dailyBudgetUsd ?? ""}
                onBlur={(event) => validateOnBlur(event, "dailyBudgetUsd")}
                aria-invalid={errors.dailyBudgetUsd ? true : undefined}
                aria-describedby={`${prefix}-daily-budget-hint${errors.dailyBudgetUsd ? ` ${prefix}-daily-budget-error` : ""}`}
                className={inputClass} />
            </Field>
            <Field id={`${prefix}-monthly-budget`} label="Monthly budget (USD)" optional error={errors.monthlyBudgetUsd} hint="Blank uses $50.00.">
              <input id={`${prefix}-monthly-budget`} name="monthlyBudgetUsd" type="number" inputMode="decimal" placeholder="50.00"
                min="0.01" max="1000000" step="0.01" defaultValue={initial ? money(initial.monthlyBudgetCents) : preset?.monthlyBudgetUsd ?? ""}
                onBlur={(event) => validateOnBlur(event, "monthlyBudgetUsd")}
                aria-invalid={errors.monthlyBudgetUsd ? true : undefined}
                aria-describedby={`${prefix}-monthly-budget-hint${errors.monthlyBudgetUsd ? ` ${prefix}-monthly-budget-error` : ""}`}
                className={inputClass} />
            </Field>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">Websites</legend>
            <p className="text-xs text-muted-foreground">Which sites the agent&apos;s browser and tools may open. Private and local network addresses are always blocked.</p>
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name={`${prefix}-web`} checked={anyPublicWeb} onChange={() => { setAnyPublicWeb(true); setErrors((current) => { const next = { ...current }; delete next.domains; return next; }); }}
                className="mt-0.5 size-4" />
              <span>Any public website <span className="text-muted-foreground">(recommended)</span></span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name={`${prefix}-web`} checked={!anyPublicWeb} onChange={() => setAnyPublicWeb(false)} className="mt-0.5 size-4" />
              <span>Only these sites</span>
            </label>
            <div hidden={anyPublicWeb} className="pl-6">
              <Field id={`${prefix}-domains`} label="Sites" error={errors.domains} hint="Comma-separated, for example example.com. A site also covers its subdomains.">
                <textarea id={`${prefix}-domains`} name="domains" rows={2} defaultValue={initial ? listText(initial.domains) : preset ? listText(preset.domains) : ""}
                  onBlur={(event) => validateOnBlur(event, "domains")}
                  aria-invalid={errors.domains ? true : undefined}
                  aria-describedby={`${prefix}-domains-hint${errors.domains ? ` ${prefix}-domains-error` : ""}`} className={textareaClass} />
              </Field>
            </div>
          </fieldset>
          <Field id={`${prefix}-tools`} label="Tools" optional error={errors.tools} hint="MCP servers this agent may call, by their pinned key (for example github). Blank means none; connect servers in Connections first.">
            <textarea id={`${prefix}-tools`} name="tools" rows={2} defaultValue={initial ? listText(initial.tools) : preset ? listText(preset.tools) : ""}
              onBlur={(event) => validateOnBlur(event, "tools")}
              aria-invalid={errors.tools ? true : undefined}
              aria-describedby={`${prefix}-tools-hint${errors.tools ? ` ${prefix}-tools-error` : ""}`} className={textareaClass} />
          </Field>
          <Field id={`${prefix}-actions`} label="Actions" error={errors.actions} hint={`Comma-separated. The defaults cover browsing, files, memory and crew handoff (handoff only works inside a crew). Opt-in: tool_call, shell, hear_audio. ${SUBAGENT_HINT}`}>
            <textarea id={`${prefix}-actions`} name="actions" rows={2} defaultValue={initial ? listText(initial.actions) : preset ? listText(preset.actions) : KNOWN_ACTIONS.join(", ")}
              onBlur={(event) => validateOnBlur(event, "actions")}
              aria-invalid={errors.actions ? true : undefined}
              aria-describedby={`${prefix}-actions-hint${errors.actions ? ` ${prefix}-actions-error` : ""}`} className={textareaClass} />
          </Field>
          <fieldset>
            <legend className="text-sm font-medium">Memory</legend>
            <p className="mt-1 text-xs text-muted-foreground">What the agent may read. Leaving all unticked uses the default: USER.md and its own MEMORY.md.</p>
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
        </div>
      </div>

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

function Field({ id, label, hint, error, optional = false, children }: {
  id: string; label: string; hint?: string; error?: string; optional?: boolean; children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium">
        {label}{optional && <span className="ml-1.5 font-normal text-muted-foreground">(optional)</span>}
      </label>
      {children}
      {hint && <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p id={`${id}-error`} className="text-sm text-danger">{error}</p>}
    </div>
  );
}
