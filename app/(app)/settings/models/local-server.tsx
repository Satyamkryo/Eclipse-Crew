"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { isLocalModelUrl, isLoopbackModelUrl, LOCAL_SERVER_PRESETS } from "@/lib/providers/local";
import { cn } from "@/lib/utils";

export const inputClass = "h-8 w-full rounded-md border border-input bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

type ProbeModel = { id: string; contextTokens: number | null };
type FoundServer = { id: string; label: string; baseUrl: string; models: ProbeModel[]; latencyMs: number };

function presetFor(baseUrl: string): string {
  return LOCAL_SERVER_PRESETS.find((preset) => preset.baseUrl && preset.baseUrl === baseUrl)?.id ?? "custom";
}

function hostPort(value: string): string {
  try { return new URL(value).host; } catch { return value; }
}

// Plain-words messages for the probe route (DESIGN.md: say what happened and what to do next).
export function localErrorMessage(code: string | undefined, baseUrl: string): string {
  if (code === "loopback_not_reachable") {
    return "localhost here means the Eclipse Crew container, not your computer. Use http://host.docker.internal:PORT/v1 for a server on this computer.";
  }
  if (code === "not_local_address") return "Check server only works with this computer, your LAN or Tailscale. For a hosted service, choose OpenAI-compatible.";
  if (code === "provider_test_failed") {
    return `Couldn't reach a model server at ${hostPort(baseUrl)}. Check it's running and listening on all interfaces, not only 127.0.0.1.`;
  }
  if (code === "rate_limited") return "Too many checks. Wait a minute and try again.";
  if (code === "authenticated_transport_unavailable") return "The egress proxy isn't available. Check the egress-proxy container is running.";
  if (code === "invalid_input") return "Enter a full address such as http://host.docker.internal:11434/v1.";
  return "Couldn't check the server. Try again.";
}

function ModelPicker({ models, onPick, label }: { models: ProbeModel[]; onPick: (id: string) => void; label: string }) {
  if (models.length === 0) return <p className="text-sm text-muted-foreground">The server is running but lists no models. Pull or load a model first.</p>;
  return (
    <ul aria-label={label} className="max-h-48 overflow-y-auto border-y border-border">
      {models.map((model) => (
        <li key={model.id} className="flex min-h-8 flex-wrap items-center justify-between gap-2 border-b border-border px-1 py-1 last:border-b-0">
          <span className="min-w-0 break-all font-mono text-xs">{model.id}</span>
          <span className="flex items-center gap-2">
            {model.contextTokens !== null && (
              <span className="font-mono text-xs tabular-nums text-muted-foreground">{model.contextTokens.toLocaleString("en")} tokens</span>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={() => onPick(model.id)} aria-label={`Use model ${model.id}`}>Use</Button>
          </span>
        </li>
      ))}
    </ul>
  );
}

// Address fields for a self-hosted OpenAI-compatible server (Ollama, LM Studio, llama.cpp, vLLM, SGLang, or a model
// on another computer over LAN/Tailscale). Renders the `baseUrl` form field; the parent owns the model field and
// receives picks through `onPickModel`. "Detect" and "Check server" call /api/models/local, which reaches only the
// owner's private network through the egress proxy.
export function LocalServerFields({ idPrefix, csrfToken, baseUrl, onBaseUrl, onPickModel, apiKeyFieldId, showPresets = true, placeholder }: {
  idPrefix: string;
  csrfToken: string;
  baseUrl: string;
  onBaseUrl: (value: string) => void;
  onPickModel: (id: string) => void;
  apiKeyFieldId?: string;
  showPresets?: boolean;
  placeholder?: string;
}) {
  const router = useRouter();
  const [preset, setPreset] = useState(() => presetFor(baseUrl));
  const [busy, setBusy] = useState<"detect" | "check" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<FoundServer[] | null>(null);
  const [models, setModels] = useState<ProbeModel[] | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const hint = LOCAL_SERVER_PRESETS.find((item) => item.id === preset)?.hint;
  const loopback = isLoopbackModelUrl(baseUrl);
  const hosted = Boolean(baseUrl) && !loopback && !isLocalModelUrl(baseUrl);

  function choosePreset(id: string) {
    setPreset(id);
    setError(null); setFound(null); setModels(null);
    const next = LOCAL_SERVER_PRESETS.find((item) => item.id === id);
    if (!next) return;
    if (next.baseUrl) onBaseUrl(next.baseUrl);
    if (next.model) onPickModel(next.model);
  }

  async function probe(body: Record<string, unknown>) {
    const response = await fetch("/api/models/local", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
      body: JSON.stringify(body),
    });
    if (response.status === 401) {
      router.push("/login");
      router.refresh();
      return null;
    }
    const result = await response.json().catch(() => ({}));
    return { ok: response.ok, result };
  }

  async function detect() {
    setBusy("detect"); setError(null); setFound(null); setModels(null);
    try {
      const answer = await probe({ detect: true });
      if (!answer) return;
      if (!answer.ok) { setError(localErrorMessage(answer.result.error, baseUrl)); return; }
      setFound(Array.isArray(answer.result.servers) ? answer.result.servers : []);
    } catch { setError("Unable to connect. Try again."); }
    finally { setBusy(null); }
  }

  async function check() {
    if (!baseUrl) { setError("Enter the server address first."); return; }
    setBusy("check"); setError(null); setFound(null); setModels(null);
    const key = apiKeyFieldId ? (document.getElementById(apiKeyFieldId) as HTMLInputElement | null)?.value ?? "" : "";
    try {
      const answer = await probe({ baseUrl, ...(key ? { apiKey: key } : {}) });
      if (!answer) return;
      if (!answer.ok) { setError(localErrorMessage(answer.result.error, baseUrl)); return; }
      setModels(Array.isArray(answer.result.models) ? answer.result.models : []);
      setLatency(typeof answer.result.latencyMs === "number" ? answer.result.latencyMs : null);
    } catch { setError("Unable to connect. Try again."); }
    finally { setBusy(null); }
  }

  return (
    <div className="flex flex-col gap-4">
      {showPresets && (
        <div className="flex flex-col gap-2">
          <label htmlFor={`${idPrefix}-local-server`} className="text-sm font-medium">Local server</label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select label="Local server" id={`${idPrefix}-local-server`} value={preset} onChange={choosePreset}
              className="w-full min-w-0 flex-1 [&>span]:w-full" selectClassName={cn(inputClass, "w-full")}>
              {LOCAL_SERVER_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </Select>
            <Button type="button" variant="secondary" onClick={detect} disabled={busy !== null} className="shrink-0">
              {busy === "detect" ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> : <Search aria-hidden="true" className="size-4" strokeWidth={1.5} />}
              Detect on this computer
            </Button>
          </div>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
      )}
      <div className="flex flex-col gap-2">
        <label htmlFor={`${idPrefix}-base-url`} className="text-sm font-medium">Server address</label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input id={`${idPrefix}-base-url`} name="baseUrl" type="url" required maxLength={2048} value={baseUrl}
            onChange={(event) => { onBaseUrl(event.target.value); setPreset(presetFor(event.target.value)); setModels(null); }}
            placeholder={placeholder ?? "http://host.docker.internal:11434/v1"} spellCheck={false} autoComplete="off"
            aria-invalid={loopback || undefined} aria-describedby={`${idPrefix}-base-hint`}
            className={cn(inputClass, "min-w-0 flex-1 font-mono", loopback && "border-danger")} />
          <Button type="button" variant="secondary" onClick={check} disabled={busy !== null} className="shrink-0">
            {busy === "check" && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
            Check server
          </Button>
        </div>
        <p id={`${idPrefix}-base-hint`} className={cn("text-xs", loopback ? "text-danger" : "text-muted-foreground")}>
          {loopback
            ? "localhost is the Eclipse Crew container. Use host.docker.internal for a server on this computer."
            : hosted
              ? "This looks like a hosted address. Hosted services need an API key and HTTPS."
              : "This computer: host.docker.internal. Another computer: its LAN IP or Tailscale name. Never open the port to the internet."}
        </p>
      </div>
      {busy && <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{busy === "detect" ? "Looking for local model servers…" : "Checking the server…"}</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {found && (
        <div role="status" aria-live="polite" className="flex flex-col gap-2">
          {found.length === 0 ? (
            <p className="text-sm text-muted-foreground">No local model server found on this computer. Start Ollama or LM Studio, or enter an address.</p>
          ) : found.map((server) => (
            <div key={server.id} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium">{server.label} found</p>
                <span className="flex items-center gap-2">
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">{server.latencyMs} ms</span>
                  <Button type="button" variant="secondary" size="sm" onClick={() => { onBaseUrl(server.baseUrl); setPreset(server.id); }}
                    aria-label={`Use ${server.label} at ${server.baseUrl}`}>Use server</Button>
                </span>
              </div>
              <p className="break-all font-mono text-xs text-muted-foreground">{server.baseUrl}</p>
              <ModelPicker models={server.models} label={`Models on ${server.label}`}
                onPick={(id) => { onBaseUrl(server.baseUrl); setPreset(server.id); onPickModel(id); }} />
            </div>
          ))}
        </div>
      )}
      {models && (
        <div role="status" aria-live="polite" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium">Server reachable</p>
            {latency !== null && <p className="font-mono text-xs tabular-nums text-muted-foreground">{latency} ms</p>}
          </div>
          <ModelPicker models={models} onPick={onPickModel} label="Models on this server" />
        </div>
      )}
    </div>
  );
}
