"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { isLocalModelUrl, LOCAL_SAM_PLACEHOLDER } from "@/lib/providers/local";
import { cn } from "@/lib/utils";
import { BackgroundModelCard, type BackgroundSettings } from "./background-model";
import { inputClass, LocalServerFields } from "./local-server";
import { TestOutput, type TestResult } from "./test-output";

type MainSettings = {
  configured: boolean;
  kind: "meta" | "openai-compatible";
  baseUrl: string | null;
  model: string;
  hasKey: boolean;
  keyHint: string | null;
  routing: "fixed" | "auto";
  hardModel: string | null;
};

type SamSettings = {
  configured: boolean;
  mode: "off" | "meta" | "local";
  baseUrl: string | null;
  useMainKey: boolean;
  hasKey: boolean;
  keyHint: string | null;
  canUseMainKey: boolean;
};

type Settings = { main: MainSettings; sam: SamSettings; background: BackgroundSettings };
type Card = "main" | "sam";
// "local" is an OpenAI-compatible server on this computer, the LAN or Tailscale (Ollama, LM Studio, llama.cpp, vLLM).
type MainChoice = "meta" | "local" | "openai-compatible";

const LOCAL_DEFAULT_URL = "http://host.docker.internal:11434/v1";
const LOCAL_DEFAULT_MODEL = "muse-glimmer";

function choiceOf(main: MainSettings): MainChoice {
  if (main.kind === "meta") return "meta";
  return isLocalModelUrl(main.baseUrl) ? "local" : "openai-compatible";
}

function errorMessage(code: string | undefined, card: Card) {
  if (code === "key_required") {
    return card === "sam" ? "Enter a key for SAM, or use the Main AI key." : "Enter an API key for this provider. Only local servers can run without one.";
  }
  if (code === "loopback_not_reachable") {
    return "localhost here means the Eclipse Crew container, not your computer. Use http://host.docker.internal:PORT/v1 instead.";
  }
  if (code === "main_key_required") return "Save a Meta key for Main AI before using the same key.";
  if (code === "sam_depends_on_main_key") return "Turn off SAM same-key mode before changing the Main AI provider.";
  if (code === "role_not_configured") return "Save this card before testing it.";
  if (code === "authenticated_transport_unavailable") return "Live provider testing is not connected yet. Your saved settings are unchanged.";
  if (code === "provider_test_failed") return "Couldn't reach this provider. Check the server is running, the address and the key, then try again.";
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

export function ModelSettings({ initial, csrfToken }: { initial: Settings; csrfToken: string }) {
  const router = useRouter();
  const [settings, setSettings] = useState(initial);
  const [mainChoice, setMainChoice] = useState<MainChoice>(choiceOf(initial.main));
  const [mainBaseUrl, setMainBaseUrl] = useState(initial.main.baseUrl ?? "");
  const [mainModel, setMainModel] = useState(initial.main.model);
  const [routing, setRouting] = useState<MainSettings["routing"]>(initial.main.routing);
  const [samMode, setSamMode] = useState<SamSettings["mode"]>(initial.sam.mode);
  const [samBaseUrl, setSamBaseUrl] = useState(initial.sam.baseUrl ?? "");
  const [useMainKey, setUseMainKey] = useState(initial.sam.useMainKey || (!initial.sam.configured && initial.sam.canUseMainKey));
  const [action, setAction] = useState<{ card: Card; kind: "save" | "test" } | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Card, string>>>({});
  const [statuses, setStatuses] = useState<Partial<Record<Card, string>>>({});
  const [testErrors, setTestErrors] = useState<Partial<Record<Card, string>>>({});
  const [testResults, setTestResults] = useState<Partial<Record<Card, TestResult>>>({});
  const mainError = useRef<HTMLParagraphElement>(null);
  const samError = useRef<HTMLParagraphElement>(null);
  const mainKind: MainSettings["kind"] = mainChoice === "meta" ? "meta" : "openai-compatible";
  const savedChoice = choiceOf(settings.main);

  function resetCard(card: Card) {
    setErrors((current) => ({ ...current, [card]: undefined }));
    setStatuses((current) => ({ ...current, [card]: undefined }));
    setTestErrors((current) => ({ ...current, [card]: undefined }));
    setTestResults((current) => ({ ...current, [card]: undefined }));
  }

  function chooseMain(next: MainChoice) {
    setMainChoice(next);
    if (next === savedChoice) {
      setMainBaseUrl(settings.main.baseUrl ?? "");
      setMainModel(settings.main.model);
      return;
    }
    if (next === "local") {
      setMainBaseUrl(LOCAL_DEFAULT_URL);
      setMainModel(LOCAL_DEFAULT_MODEL);
    } else if (next === "openai-compatible") {
      setMainBaseUrl("");
      setMainModel("");
    } else {
      setMainModel("muse-spark-1.3");
    }
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
          model: mainModel.trim(),
          routing,
          ...(routing === "auto" ? { hardModel: data.get("hardModel") } : {}),
          ...(mainKind === "openai-compatible" ? { baseUrl: mainBaseUrl.trim() } : {}),
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
      const next = result as Settings;
      setSettings(next);
      setMainChoice(choiceOf(next.main));
      setMainBaseUrl(next.main.baseUrl ?? "");
      setMainModel(next.main.model);
      setRouting(next.main.routing);
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
    const body = samMode === "local"
      ? { mode: "local", useMainKey: false, baseUrl: samBaseUrl.trim(), ...(apiKey ? { apiKey } : {}) }
      : {
        mode: samMode,
        useMainKey: samMode === "meta" && useMainKey,
        ...(samMode === "meta" && !useMainKey && apiKey ? { apiKey } : {}),
      };
    try {
      const response = await fetch("/api/models/roles/sam", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(body),
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
      setSamBaseUrl(next.sam.baseUrl ?? "");
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
  // A saved key is shown and reused only for the provider it was saved for.
  const mainKeyApplies = settings.main.hasKey && savedChoice === mainChoice;
  const samKeyApplies = settings.sam.hasKey && settings.sam.mode === samMode && !settings.sam.useMainKey;
  const mainLocal = mainChoice === "local";

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-border bg-card p-4" aria-labelledby="main-ai-heading">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
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
            <Select label="Provider" id="main-provider" name="provider" value={mainChoice} onChange={(value) => chooseMain(value as MainChoice)}
              className="w-full [&>span]:w-full" selectClassName={cn(inputClass, "w-full")}>
              <option value="meta">Meta Model API</option>
              <option value="local">Local model (your own GPU)</option>
              <option value="openai-compatible">OpenAI-compatible (hosted)</option>
            </Select>
            {mainLocal && (
              <p className="text-xs text-muted-foreground">
                Runs on your own GPU, for example Muse Glimmer. Needs tool calling and image input. No API key and no usage cost.
              </p>
            )}
          </div>
          {mainLocal && (
            <LocalServerFields idPrefix="main" csrfToken={csrfToken} baseUrl={mainBaseUrl} onBaseUrl={setMainBaseUrl}
              onPickModel={setMainModel} apiKeyFieldId="main-api-key" />
          )}
          {mainChoice === "openai-compatible" && (
            <div className="flex flex-col gap-2">
              <label htmlFor="main-base-url" className="text-sm font-medium">Base URL</label>
              <input id="main-base-url" name="baseUrl" type="url" required maxLength={2048} value={mainBaseUrl}
                onChange={(event) => setMainBaseUrl(event.target.value)}
                placeholder="https://openrouter.ai/api/v1" spellCheck={false} autoComplete="off" className={cn(inputClass, "font-mono")}
                aria-describedby="main-base-hint" />
              <p id="main-base-hint" className="text-xs text-muted-foreground">The provider&apos;s HTTPS address. For a server on your own computer, choose Local model.</p>
            </div>
          )}
          <div className="flex flex-col gap-2">
            <label htmlFor="main-model" className="text-sm font-medium">Model</label>
            <input id="main-model" name="model" required maxLength={200} value={mainModel} onChange={(event) => setMainModel(event.target.value)}
              placeholder={mainLocal ? LOCAL_DEFAULT_MODEL : undefined} aria-describedby={mainLocal ? "main-model-hint" : undefined}
              spellCheck={false} autoComplete="off" className={cn(inputClass, "font-mono")} />
            {mainLocal && (
              <p id="main-model-hint" className="text-xs text-muted-foreground">
                The id your server lists. Ollama, vLLM, SGLang and llama.cpp (with -a muse-glimmer) serve Glimmer as muse-glimmer. Use Check server to pick one.
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="main-routing" className="text-sm font-medium">Routing</label>
            <Select label="Routing" id="main-routing" name="routing" value={routing} onChange={(value) => setRouting(value as MainSettings["routing"])}
              className="w-full [&>span]:w-full" selectClassName={cn(inputClass, "w-full")}>
              <option value="fixed">Fixed: always use this model</option>
              <option value="auto">Auto: use a stronger model for hard steps</option>
            </Select>
            <p id="main-routing-hint" className="text-xs text-muted-foreground">
              Fixed never uses a second model. Auto switches only after a step fails or repeats, at most 5 times per run, and falls back to this model if the other one is unavailable.
            </p>
          </div>
          {routing === "auto" && (
            <div className="flex flex-col gap-2">
              <label htmlFor="main-hard-model" className="text-sm font-medium">Hard-step model</label>
              <input id="main-hard-model" name="hardModel" required maxLength={200} defaultValue={settings.main.hardModel ?? ""}
                placeholder={mainLocal ? "a larger model on the same server" : "muse-wonder-1.0"} spellCheck={false} autoComplete="off"
                aria-describedby="main-hard-hint" className={cn(inputClass, "font-mono")} />
              <p id="main-hard-hint" className="text-xs text-muted-foreground">
                {mainLocal
                  ? "Uses the same server and key, so it must be a model that server lists."
                  : "Uses the same provider and key. Muse Wonder has no Contributor mode, so any other model is billed at its standard rate and is not covered by Contributor pricing or data terms."}
              </p>
            </div>
          )}
          <div className="flex flex-col gap-2">
            <label htmlFor="main-api-key" className="text-sm font-medium">{mainLocal ? "API key (optional)" : "API key"}</label>
            <input id="main-api-key" name="apiKey" type="password" maxLength={16384} autoComplete="new-password"
              required={!mainLocal && !mainKeyApplies}
              placeholder={mainKeyApplies ? settings.main.keyHint ?? "Saved key" : mainLocal ? "Only if your server uses one" : "Paste the provider key"}
              aria-describedby="main-key-hint" className={inputClass} />
            <p id="main-key-hint" className="text-xs text-muted-foreground">
              {mainKeyApplies && settings.main.keyHint
                ? `Saved key ${settings.main.keyHint}. Leave blank to keep it.`
                : mainLocal
                  ? "Leave blank for Ollama and LM Studio. Fill it in for llama.cpp or vLLM started with --api-key."
                  : "Stored encrypted on this machine. There is no reveal button."}
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
        <div className="min-w-0">
          <h2 id="sam-heading" className="text-lg font-semibold tracking-tight">Vision precision (SAM 3.1)</h2>
          <p className="mt-1 text-sm text-muted-foreground">Optional pixel-precise grounding for design tools, canvas apps, maps and games.</p>
        </div>
        <form onSubmit={saveSam} className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label htmlFor="sam-mode" className="text-sm font-medium">Mode</label>
            <Select label="Mode" id="sam-mode" name="mode" value={samMode}
              onChange={(value) => {
                const mode = value as SamSettings["mode"];
                setSamMode(mode);
                if (mode === "meta" && !settings.sam.configured && settings.sam.canUseMainKey) setUseMainKey(true);
                if (mode === "local" && !samBaseUrl) setSamBaseUrl(LOCAL_SAM_PLACEHOLDER);
              }} className="w-full [&>span]:w-full" selectClassName={cn(inputClass, "w-full")}>
              <option value="off">Off</option>
              <option value="meta">Meta API</option>
              <option value="local">Local server (your NVIDIA GPU)</option>
            </Select>
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
                    required={!samKeyApplies}
                    placeholder={samKeyApplies ? settings.sam.keyHint ?? "Saved key" : "Paste a Meta key"}
                    aria-describedby="sam-key-hint" className={inputClass} />
                  <p id="sam-key-hint" className="text-xs text-muted-foreground">
                    {samKeyApplies && settings.sam.keyHint ? `Saved key ${settings.sam.keyHint}. Leave blank to keep it.` : "Stored encrypted on this machine."}
                  </p>
                </div>
              )}
            </>
          )}
          {samMode === "local" && (
            <>
              <p className="text-xs text-muted-foreground">
                Runs SAM 3.1 on your own GPU. Download the weights yourself from Hugging Face after accepting Meta&apos;s SAM License; Eclipse Crew never ships them.
                Your server must answer POST /v1/responses like Meta&apos;s SAM API and list sam-3.1 at /v1/models. The README has the full contract.
              </p>
              <LocalServerFields idPrefix="sam" csrfToken={csrfToken} baseUrl={samBaseUrl} onBaseUrl={setSamBaseUrl}
                onPickModel={() => {}} apiKeyFieldId="sam-local-key" showPresets={false} placeholder={LOCAL_SAM_PLACEHOLDER} />
              <div className="flex flex-col gap-2">
                <label htmlFor="sam-local-key" className="text-sm font-medium">API key (optional)</label>
                <input id="sam-local-key" name="apiKey" type="password" maxLength={16384} autoComplete="new-password"
                  placeholder={samKeyApplies ? settings.sam.keyHint ?? "Saved key" : "Only if your server uses one"}
                  aria-describedby="sam-local-key-hint" className={inputClass} />
                <p id="sam-local-key-hint" className="text-xs text-muted-foreground">
                  {samKeyApplies && settings.sam.keyHint ? `Saved key ${settings.sam.keyHint}. Leave blank to keep it.` : "Sent as a Bearer token by the egress proxy. Stored encrypted on this machine."}
                </p>
              </div>
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

      <BackgroundModelCard initial={settings.background} csrfToken={csrfToken} />
    </div>
  );
}
