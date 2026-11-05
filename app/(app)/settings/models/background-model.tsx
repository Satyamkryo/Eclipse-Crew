"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { isLocalModelUrl } from "@/lib/providers/local";
import { inputClass, LocalServerFields } from "./local-server";
import { TestOutput, type TestResult } from "./test-output";

export type BackgroundSettings = {
  configured: boolean;
  kind: "meta" | "openai-compatible";
  baseUrl: string | null;
  model: string;
  hasKey: boolean;
  keyHint: string | null;
};

// "local" is an OpenAI-compatible server on this computer, the LAN or Tailscale, e.g. Muse Glimmer on Ollama.
type BackgroundChoice = "meta" | "local" | "openai-compatible";

function choiceOf(kind: BackgroundSettings["kind"], baseUrl: string | null): BackgroundChoice {
  if (kind === "meta") return "meta";
  return isLocalModelUrl(baseUrl) ? "local" : "openai-compatible";
}

// TASK-086. Optional model for background memory review and tidy. When off, those jobs use Main AI.
function bgErrorMessage(code: string | undefined): string {
  if (code === "key_required") return "Enter an API key for this provider. Only local servers can run without one.";
  if (code === "loopback_not_reachable") return "localhost here means the Eclipse Crew container. Use http://host.docker.internal:PORT/v1 instead.";
  if (code === "role_not_configured") return "Save this card before testing.";
  if (code === "authenticated_transport_unavailable") return "Live provider testing is not connected yet. Your saved settings are unchanged.";
  if (code === "provider_test_failed") return "Couldn't test this provider. Check the endpoint and key, then try again.";
  if (code === "rate_limited") return "Too many tests. Wait a minute and try again.";
  if (code === "invalid_input") return "Review the values and try again.";
  return "Couldn't test the background model. Try again.";
}

export function BackgroundModelCard({ initial, csrfToken }: { initial: BackgroundSettings; csrfToken: string }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial.configured);
  const [configured, setConfigured] = useState(initial.configured);
  const [hasKey, setHasKey] = useState(initial.hasKey);
  const [savedChoice, setSavedChoice] = useState<BackgroundChoice>(choiceOf(initial.kind, initial.baseUrl));
  const [choice, setChoice] = useState<BackgroundChoice>(savedChoice);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl ?? "");
  const [model, setModel] = useState(initial.model);
  const kind: BackgroundSettings["kind"] = choice === "meta" ? "meta" : "openai-compatible";
  const local = choice === "local";
  const keyApplies = hasKey && choice === savedChoice;

  function choose(next: BackgroundChoice) {
    setChoice(next);
    if (next === savedChoice) { setBaseUrl(initial.baseUrl ?? ""); setModel(initial.model); return; }
    if (next === "local") { setBaseUrl("http://host.docker.internal:11434/v1"); setModel("muse-glimmer"); }
    else if (next === "openai-compatible") { setBaseUrl(""); setModel(""); }
    else setModel("muse-spark-1.3");
  }
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

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
          model: model.trim(),
          ...(kind === "openai-compatible" ? { baseUrl: baseUrl.trim() } : {}),
          ...(String(data.get("apiKey") ?? "") ? { apiKey: String(data.get("apiKey")) } : {}),
        } : { enabled: false, kind: initial.kind, model: initial.model }),
      });
      if (response.status === 401) {
        router.push("/login");
        router.refresh();
        return;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.error === "key_required" || body.error === "loopback_not_reachable" ? bgErrorMessage(body.error) : "Couldn't save the background model. Try again.");
        return;
      }
      const pastedKey = String(data.get("apiKey") ?? "") !== "";
      setConfigured(enabled);
      if (enabled) {
        // A key is kept only for the same provider at the same address.
        if (pastedKey) setHasKey(true);
        else if (choice !== savedChoice) setHasKey(false);
        setSavedChoice(choice);
      }
      setTestResult(null);
      setTestError(null);
      const keyInput = form.querySelector<HTMLInputElement>("input[name=apiKey]");
      if (keyInput) keyInput.value = "";
      setStatus(enabled ? "Background model saved." : "Background model is off. Memory jobs use Main AI.");
      router.refresh();
    } catch { setError("Unable to connect. Try again."); }
    finally { setSaving(false); }
  }

  async function runTest() {
    if (saving || testing || !configured) return;
    setTesting(true); setTestResult(null); setTestError(null);
    try {
      const response = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ role: "background" }),
      });
      if (response.status === 401) {
        router.push("/login");
        router.refresh();
        return;
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setTestError(bgErrorMessage(body.error));
        return;
      }
      setTestResult(body as TestResult);
    } catch { setTestError("Unable to connect. Try again."); }
    finally { setTesting(false); }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4" aria-labelledby="background-heading">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="background-heading" className="text-lg font-semibold tracking-tight">Background model (optional)</h2>
          <p className="mt-1 text-sm text-muted-foreground">Memory review and nightly tidy. Leave it off to use Main AI.</p>
        </div>
        {configured && <span className="rounded-md bg-surface px-2 py-1 text-xs font-medium">Saved {initial.keyHint ? `key ${initial.keyHint}` : hasKey ? "key" : ""}</span>}
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
              <Select label="Provider" id="background-provider" value={choice} onChange={(value) => choose(value as BackgroundChoice)}
                className="w-full [&>span]:w-full" selectClassName={inputClass + " w-full"}>
                <option value="meta">Meta Model API</option>
                <option value="local">Local model (your own GPU)</option>
                <option value="openai-compatible">OpenAI-compatible (hosted)</option>
              </Select>
              {local && <p className="text-xs text-muted-foreground">A local model such as Muse Glimmer keeps memory jobs on your own machine at no usage cost.</p>}
            </div>
            {local && (
              <LocalServerFields idPrefix="background" csrfToken={csrfToken} baseUrl={baseUrl} onBaseUrl={setBaseUrl}
                onPickModel={setModel} apiKeyFieldId="background-api-key" />
            )}
            {choice === "openai-compatible" && (
              <div className="flex flex-col gap-2">
                <label htmlFor="background-base-url" className="text-sm font-medium">Base URL</label>
                <input id="background-base-url" name="baseUrl" type="url" required maxLength={2048} value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)} spellCheck={false} autoComplete="off"
                  placeholder="https://openrouter.ai/api/v1" className={inputClass + " font-mono"} />
              </div>
            )}
            <div className="flex flex-col gap-2">
              <label htmlFor="background-model" className="text-sm font-medium">Model</label>
              <input id="background-model" name="model" required maxLength={200} value={model} onChange={(event) => setModel(event.target.value)}
                spellCheck={false} autoComplete="off" placeholder={local ? "muse-glimmer" : undefined} className={inputClass + " font-mono"} />
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="background-api-key" className="text-sm font-medium">{local ? "API key (optional)" : "API key"}</label>
              <input id="background-api-key" name="apiKey" type="password" autoComplete="new-password" maxLength={16384}
                required={!local && !keyApplies}
                placeholder={keyApplies ? "Saved key. Leave blank to keep it." : local ? "Only if your server uses one" : "Paste the key"} className={inputClass} />
            </div>
          </>
        ) : null}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {status && <p role="status" aria-live="polite" className="text-sm text-success">{status}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" disabled={saving || testing || !configured} onClick={runTest}>
            {testing && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
            Test
          </Button>
          <Button type="submit" disabled={saving || testing} size="sm">
            {saving ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> : null}
            Save background model
          </Button>
        </div>
      </form>
      {!configured && (
        <p className="mt-2 text-right text-xs text-muted-foreground">Save this card before testing.</p>
      )}
      {(testResult || testError || testing) && (
        <div className="mt-4 border-t border-border pt-4">
          <TestOutput result={testResult} error={testError} loading={testing} />
        </div>
      )}
    </section>
  );
}
