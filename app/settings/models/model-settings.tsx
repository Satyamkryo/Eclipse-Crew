"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type MainSettings = {
  configured: boolean;
  kind: "meta" | "openai-compatible";
  baseUrl: string | null;
  model: string;
  hasKey: boolean;
  keyHint: string | null;
};

type SamSettings = {
  configured: boolean;
  mode: "off" | "meta";
  useMainKey: boolean;
  hasKey: boolean;
  keyHint: string | null;
  canUseMainKey: boolean;
};

type Settings = { main: MainSettings; sam: SamSettings };
type TestResult = { models: Array<{ id: string; contextTokens: number | null }>; latencyMs: number };
type Card = "main" | "sam";

const inputClass = "h-8 w-full rounded-md border border-input bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

function errorMessage(code: string | undefined, card: Card) {
  if (code === "key_required") {
    return card === "sam" ? "Enter a Meta key for SAM, or use the Main AI key." : "Enter an API key for this provider.";
  }
  if (code === "main_key_required") return "Save a Meta key for Main AI before using the same key.";
  if (code === "sam_depends_on_main_key") return "Turn off SAM same-key mode before changing the Main AI provider.";
  if (code === "role_not_configured") return "Save this card before testing it.";
  if (code === "authenticated_transport_unavailable") return "Live provider testing is not connected yet. Your saved settings are unchanged.";
  if (code === "provider_test_failed") return "Couldn't test this provider. Check the endpoint and key, then try again.";
  if (code === "rate_limited") return "Too many tests. Wait a minute and try again.";
  if (code === "invalid_input") return "Review the values and try again.";
  return card === "main" ? "Couldn't save Main AI settings. Try again." : "Couldn't save SAM settings. Try again.";
}

function SaveStatus({ error, status, errorRef }: {
  error: string | null;
  status: string | null;
  errorRef: React.RefObject<HTMLParagraphElement | null>;
}) {
  return (
    <>
      {error && <p ref={errorRef} role="alert" tabIndex={-1} className="text-sm text-danger">{error}</p>}
      {status && <p role="status" aria-live="polite" className="text-sm text-success">{status}</p>}
    </>
  );
}

function TestOutput({ result, error, loading }: { result: TestResult | null; error: string | null; loading: boolean }) {
  if (loading) {
    return <p role="status" aria-live="polite" className="text-sm text-muted-foreground">Testing the saved provider…</p>;
  }
  if (error) return <p role="alert" className="text-sm text-danger">{error}</p>;
  if (!result) return null;
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">Provider reachable</p>
        <p className="font-mono text-xs tabular-nums text-muted-foreground">{result.latencyMs} ms</p>
      </div>
      {result.models.length === 0 ? (
        <p className="text-sm text-muted-foreground">The provider returned no models.</p>
      ) : (
        <div className="max-h-56 overflow-y-auto border-y border-border">
          <ul aria-label="Available models">
            {result.models.map((model) => (
              <li key={model.id} className="flex min-h-8 flex-wrap items-center justify-between gap-2 border-b border-border px-1 py-1 last:border-b-0">
                <span className="break-all font-mono text-xs">{model.id}</span>
                {model.contextTokens !== null && (
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">{model.contextTokens.toLocaleString("en")} tokens</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function ModelSettings({ initial, csrfToken }: { initial: Settings; csrfToken: string }) {
  const router = useRouter();
  const [settings, setSettings] = useState(initial);
  const [mainKind, setMainKind] = useState<MainSettings["kind"]>(initial.main.kind);
  const [samMode, setSamMode] = useState<SamSettings["mode"]>(initial.sam.mode);
  const [useMainKey, setUseMainKey] = useState(initial.sam.useMainKey || (!initial.sam.configured && initial.sam.canUseMainKey));
  const [action, setAction] = useState<{ card: Card; kind: "save" | "test" } | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Card, string>>>({});
  const [statuses, setStatuses] = useState<Partial<Record<Card, string>>>({});
  const [testErrors, setTestErrors] = useState<Partial<Record<Card, string>>>({});
  const [testResults, setTestResults] = useState<Partial<Record<Card, TestResult>>>({});
  const mainError = useRef<HTMLParagraphElement>(null);
  const samError = useRef<HTMLParagraphElement>(null);

  function resetCard(card: Card) {
    setErrors((current) => ({ ...current, [card]: undefined }));
    setStatuses((current) => ({ ...current, [card]: undefined }));
    setTestErrors((current) => ({ ...current, [card]: undefined }));
    setTestResults((current) => ({ ...current, [card]: undefined }));
  }

  async function saveMain(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    resetCard("main");
    setAction({ card: "main", kind: "save" });
    const data = new FormData(form);
    const apiKey = String(data.get("apiKey") ?? "");
    try {
      const response = await fetch("/api/models/roles/main", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({
          kind: mainKind,
          model: data.get("model"),
          ...(mainKind === "openai-compatible" ? { baseUrl: data.get("baseUrl") } : {}),
          ...(apiKey ? { apiKey } : {}),
        }),
      });
      if (response.status === 401) {
        router.push("/login");
        router.refresh();
        return;
      }
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setErrors((current) => ({ ...current, main: errorMessage(result.error, "main") }));
        requestAnimationFrame(() => mainError.current?.focus());
        return;
      }
      setSettings(result as Settings);
      setMainKind((result as Settings).main.kind);
      const keyInput = form.querySelector<HTMLInputElement>("input[name=apiKey]");
      if (keyInput) keyInput.value = "";
      setStatuses((current) => ({ ...current, main: "Main AI saved." }));
      router.refresh();
    } catch {
      setErrors((current) => ({ ...current, main: "Unable to connect. Try again." }));
      requestAnimationFrame(() => mainError.current?.focus());
    } finally {
      setAction(null);
    }
  }

  async function saveSam(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    resetCard("sam");
    setAction({ card: "sam", kind: "save" });
    const data = new FormData(form);
    const apiKey = String(data.get("apiKey") ?? "");
    try {
      const response = await fetch("/api/models/roles/sam", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({
          mode: samMode,
          useMainKey: samMode === "meta" && useMainKey,
          ...(samMode === "meta" && !useMainKey && apiKey ? { apiKey } : {}),
        }),
      });
      if (response.status === 401) {
        router.push("/login");
        router.refresh();
        return;
      }
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setErrors((current) => ({ ...current, sam: errorMessage(result.error, "sam") }));
        requestAnimationFrame(() => samError.current?.focus());
        return;
      }
      const next = result as Settings;
      setSettings(next);
      setSamMode(next.sam.mode);
      setUseMainKey(next.sam.useMainKey);
      const keyInput = form.querySelector<HTMLInputElement>("input[name=apiKey]");
      if (keyInput) keyInput.value = "";
      setStatuses((current) => ({ ...current, sam: next.sam.mode === "off" ? "SAM is off." : "SAM saved." }));
      router.refresh();
    } catch {
      setErrors((current) => ({ ...current, sam: "Unable to connect. Try again." }));
      requestAnimationFrame(() => samError.current?.focus());
    } finally {
      setAction(null);
    }
  }

  async function test(card: Card) {
    resetCard(card);
    setAction({ card, kind: "test" });
    try {
      const response = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ role: card }),
      });
      if (response.status === 401) {
        router.push("/login");
        router.refresh();
        return;
      }
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setTestErrors((current) => ({ ...current, [card]: errorMessage(result.error, card) }));
        return;
      }
      setTestResults((current) => ({ ...current, [card]: result as TestResult }));
    } catch {
      setTestErrors((current) => ({ ...current, [card]: "Unable to connect. Try again." }));
    } finally {
      setAction(null);
    }
  }

  const mainBusy = action?.card === "main";
  const samBusy = action?.card === "sam";
  const canSameKey = settings.sam.canUseMainKey;

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-border bg-card p-4" aria-labelledby="main-ai-heading">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 id="main-ai-heading" className="text-lg font-semibold tracking-tight">Main AI</h2>
            <p className="mt-1 text-sm text-muted-foreground">Plans, writes and decides every step. Tool calling is required.</p>
          </div>
          {!settings.main.configured && (
            <span className="rounded-md bg-corona/12 px-2 py-1 text-xs font-medium text-corona">Setup needed</span>
          )}
        </div>
        <form onSubmit={saveMain} className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label htmlFor="main-provider" className="text-sm font-medium">Provider</label>
            <select id="main-provider" name="provider" value={mainKind} onChange={(event) => setMainKind(event.target.value as MainSettings["kind"])}
              className={inputClass}>
              <option value="meta">Meta Model API</option>
              <option value="openai-compatible">OpenAI-compatible</option>
            </select>
          </div>
          {mainKind === "openai-compatible" && (
            <div className="flex flex-col gap-2">
              <label htmlFor="main-base-url" className="text-sm font-medium">Base URL</label>
              <input id="main-base-url" name="baseUrl" type="url" required maxLength={2048} defaultValue={settings.main.baseUrl ?? ""}
                placeholder="http://host.docker.internal:11434/v1" className={inputClass}
                aria-describedby="main-base-hint" />
              <p id="main-base-hint" className="text-xs text-muted-foreground">Use the server&apos;s HTTP(S) address. Local endpoints may not need a key.</p>
            </div>
          )}
          <div className="flex flex-col gap-2">
            <label htmlFor="main-model" className="text-sm font-medium">Model</label>
            <input id="main-model" name="model" required maxLength={200} defaultValue={settings.main.model}
              spellCheck={false} autoComplete="off" className={cn(inputClass, "font-mono")} />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="main-api-key" className="text-sm font-medium">API key</label>
            <input id="main-api-key" name="apiKey" type="password" maxLength={16384} autoComplete="new-password"
              required={mainKind === "meta" && !settings.main.hasKey}
              placeholder={settings.main.keyHint ?? "Paste the provider key"}
              aria-describedby="main-key-hint" className={inputClass} />
            <p id="main-key-hint" className="text-xs text-muted-foreground">
              {settings.main.keyHint ? `Saved key ${settings.main.keyHint}. Leave blank to keep it.` : "Stored encrypted on this machine. There is no reveal button."}
            </p>
          </div>
          <SaveStatus error={errors.main ?? null} status={statuses.main ?? null} errorRef={mainError} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="secondary" disabled={action !== null || !settings.main.configured}
              onClick={() => test("main")}>
              {mainBusy && action?.kind === "test" && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
              Test
            </Button>
            <Button type="submit" disabled={action !== null}>
              {mainBusy && action?.kind === "save" && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
              Save Main AI
            </Button>
          </div>
        </form>
        {!settings.main.configured && (
          <p className="mt-2 text-right text-xs text-muted-foreground">Save this card before testing.</p>
        )}
        {(testResults.main || testErrors.main || (mainBusy && action?.kind === "test")) && (
          <div className="mt-4 border-t border-border pt-4">
            <TestOutput result={testResults.main ?? null} error={testErrors.main ?? null} loading={mainBusy && action?.kind === "test"} />
          </div>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card p-4" aria-labelledby="sam-heading">
        <div>
          <h2 id="sam-heading" className="text-lg font-semibold tracking-tight">Vision precision (SAM 3.1)</h2>
          <p className="mt-1 text-sm text-muted-foreground">Optional pixel-precise grounding for design tools, canvas apps, maps and games.</p>
        </div>
        <form onSubmit={saveSam} className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label htmlFor="sam-mode" className="text-sm font-medium">Mode</label>
            <select id="sam-mode" name="mode" value={samMode}
              onChange={(event) => {
                const mode = event.target.value as SamSettings["mode"];
                setSamMode(mode);
                if (mode === "meta" && !settings.sam.configured && settings.sam.canUseMainKey) setUseMainKey(true);
              }} className={inputClass}>
              <option value="off">Off</option>
              <option value="meta">Meta API</option>
            </select>
          </div>
          {samMode === "meta" && (
            <>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={useMainKey} disabled={!canSameKey}
                  onChange={(event) => setUseMainKey(event.target.checked)}
                  aria-describedby="sam-same-key-hint" className="mt-0.5 size-4 rounded border-input" />
                <span>
                  Use the same key as Main AI
                  <span id="sam-same-key-hint" className="mt-1 block text-xs text-muted-foreground">
                    {canSameKey ? "Uses the Main AI Meta key without storing another copy." : "Save a Meta key for Main AI first."}
                  </span>
                </span>
              </label>
              {!useMainKey && (
                <div className="flex flex-col gap-2">
                  <label htmlFor="sam-api-key" className="text-sm font-medium">SAM API key</label>
                  <input id="sam-api-key" name="apiKey" type="password" maxLength={16384} autoComplete="new-password"
                    required={!settings.sam.hasKey || settings.sam.useMainKey}
                    placeholder={!settings.sam.useMainKey ? settings.sam.keyHint ?? "Paste a Meta key" : "Paste a Meta key"}
                    aria-describedby="sam-key-hint" className={inputClass} />
                  <p id="sam-key-hint" className="text-xs text-muted-foreground">
                    {!settings.sam.useMainKey && settings.sam.keyHint ? `Saved key ${settings.sam.keyHint}. Leave blank to keep it.` : "Stored encrypted on this machine."}
                  </p>
                </div>
              )}
            </>
          )}
          <SaveStatus error={errors.sam ?? null} status={statuses.sam ?? null} errorRef={samError} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="secondary" disabled={action !== null || !settings.sam.configured}
              onClick={() => test("sam")}>
              {samBusy && action?.kind === "test" && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
              Test
            </Button>
            <Button type="submit" disabled={action !== null}>
              {samBusy && action?.kind === "save" && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
              Save SAM
            </Button>
          </div>
        </form>
        {!settings.sam.configured && (
          <p className="mt-2 text-right text-xs text-muted-foreground">{samMode === "off" ? "SAM is off. Everyday websites work without it." : "Save this card before testing."}</p>
        )}
        {(testResults.sam || testErrors.sam || (samBusy && action?.kind === "test")) && (
          <div className="mt-4 border-t border-border pt-4">
            <TestOutput result={testResults.sam ?? null} error={testErrors.sam ?? null} loading={samBusy && action?.kind === "test"} />
          </div>
        )}
      </section>
    </div>
  );
}
