"use client";

import { useState } from "react";
import { LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";

export type BackgroundSettings = {
  configured: boolean;
  kind: "meta" | "openai-compatible";
  baseUrl: string | null;
  model: string;
  hasKey: boolean;
  keyHint: string | null;
};

const inputClass = "h-8 w-full rounded-md border border-input bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

// TASK-086. Optional model for background memory review and tidy. When off, those jobs use Main AI.
export function BackgroundModelCard({ initial, csrfToken }: { initial: BackgroundSettings; csrfToken: string }) {
  const [enabled, setEnabled] = useState(initial.configured);
  const [kind, setKind] = useState<BackgroundSettings["kind"]>(initial.kind);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    setSaving(true); setError(null); setStatus(null);
    const data = new FormData(form);
    try {
      const response = await fetch("/api/models/roles/background", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(enabled ? {
          enabled: true, kind,
          model: String(data.get("model") ?? ""),
          ...(kind === "openai-compatible" ? { baseUrl: String(data.get("baseUrl") ?? "") } : {}),
          ...(String(data.get("apiKey") ?? "") ? { apiKey: String(data.get("apiKey")) } : {}),
        } : { enabled: false, kind: initial.kind, model: initial.model }),
      });
      if (!response.ok) { setError("Couldn't save the background model. Try again."); return; }
      setStatus(enabled ? "Background model saved." : "Background model is off. Memory jobs use Main AI.");
    } catch { setError("Unable to connect. Try again."); }
    finally { setSaving(false); }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4" aria-labelledby="background-heading">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="background-heading" className="text-lg font-semibold tracking-tight">Background model (optional)</h2>
          <p className="mt-1 text-sm text-muted-foreground">Memory review and nightly tidy. Leave it off to use Main AI.</p>
        </div>
        {initial.configured && <span className="rounded-md bg-surface px-2 py-1 text-xs font-medium">Saved {initial.keyHint ? `key ${initial.keyHint}` : ""}</span>}
      </div>
      <form onSubmit={save} className="mt-4 flex flex-col gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="size-4 rounded border-input" />
          Use a separate model for memory jobs
        </label>
        {enabled ? (
          <>
            <div className="flex flex-col gap-2">
              <label htmlFor="background-provider" className="text-sm font-medium">Provider</label>
              <select id="background-provider" value={kind} onChange={(event) => setKind(event.target.value as BackgroundSettings["kind"])} className={inputClass}>
                <option value="meta">Meta Model API</option>
                <option value="openai-compatible">OpenAI-compatible</option>
              </select>
            </div>
            {kind === "openai-compatible" && (
              <div className="flex flex-col gap-2">
                <label htmlFor="background-base-url" className="text-sm font-medium">Base URL</label>
                <input id="background-base-url" name="baseUrl" type="url" required maxLength={2048} defaultValue={initial.baseUrl ?? ""}
                  placeholder="http://host.docker.internal:11434/v1" className={inputClass} />
              </div>
            )}
            <div className="flex flex-col gap-2">
              <label htmlFor="background-model" className="text-sm font-medium">Model</label>
              <input id="background-model" name="model" required maxLength={200} defaultValue={initial.model} className={inputClass} />
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="background-api-key" className="text-sm font-medium">API key</label>
              <input id="background-api-key" name="apiKey" type="password" autoComplete="off" maxLength={16384}
                placeholder={initial.hasKey ? "Saved key. Leave blank to keep it." : "Paste the key"} className={inputClass} />
            </div>
          </>
        ) : null}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {status && <p role="status" aria-live="polite" className="text-sm text-success">{status}</p>}
        <div className="flex justify-end">
          <Button type="submit" disabled={saving} size="sm">
            {saving ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> : null}
            Save background model
          </Button>
        </div>
      </form>
    </section>
  );
}
