import "server-only";

import { createProviderConnector } from "../providers";
import { isLocalModelUrl, isLoopbackModelUrl, LOCAL_SERVER_PRESETS } from "../providers/local";
import { normalizeBaseUrl } from "../providers/transport";
import type { ProviderTransport } from "../providers/types";
import type { ModelSettingsStore, StoredProvider } from "./data";
import type { LocalProbeInput, ModelRole } from "./schema";
import { ModelSettingsError } from "./errors";

const MAX_TEST_MODELS = 200;
// Detect tries a few same-computer addresses; a closed port answers at once, so a short limit is enough.
const DETECT_TIMEOUT_MS = 4_000;
const PROBE_TIMEOUT_MS = 15_000;

export type ModelTestResult = {
  models: Array<{ id: string; contextTokens: number | null }>;
  latencyMs: number;
};

export type LocalServerFound = ModelTestResult & { id: string; label: string; baseUrl: string };
export type LocalProbeResult = ModelTestResult | { servers: LocalServerFound[] };

async function listWith(provider: Pick<StoredProvider, "kind" | "baseUrl">, transport: ProviderTransport, timeoutMs?: number) {
  let connector;
  try {
    connector = createProviderConnector(provider.kind === "meta"
      ? { kind: "meta", transport }
      : { kind: "openai-compatible", baseUrl: provider.baseUrl ?? "", transport, ...(timeoutMs ? { timeoutMs } : {}) });
  } catch {
    throw new ModelSettingsError("role_not_configured");
  }
  const started = performance.now();
  let models;
  try {
    models = await connector.listModels();
  } catch {
    throw new ModelSettingsError("provider_test_failed", 502);
  }
  return {
    models: models.slice(0, MAX_TEST_MODELS).map(({ id, contextTokens }) => ({ id, contextTokens })),
    latencyMs: Math.max(0, Math.round(performance.now() - started)),
  };
}

export async function testSavedRole(
  store: ModelSettingsStore,
  ownerId: string,
  role: ModelRole,
  transport?: ProviderTransport,
  transportFor?: (provider: StoredProvider) => ProviderTransport | null,
): Promise<ModelTestResult> {
  if (typeof transport !== "function" && typeof transportFor !== "function") {
    throw new ModelSettingsError("authenticated_transport_unavailable", 503);
  }
  const settings = await store.load(ownerId);
  const selected = settings[role];
  const provider = selected?.useMainKey ? settings.main?.provider : selected?.provider;
  if (!selected?.model || !provider || (role === "sam" && selected.mode !== "meta" && selected.mode !== "local")) {
    throw new ModelSettingsError("role_not_configured");
  }

  const effective = typeof transport === "function" ? transport : transportFor?.(provider);
  if (typeof effective !== "function") {
    throw new ModelSettingsError("authenticated_transport_unavailable", 503);
  }
  return listWith(provider, effective);
}

// Lists the models of an unsaved local server (Settings → Models "Check server"), or tries the known same-computer
// addresses ("Detect"). Only local addresses are accepted: this is never a way to reach a hosted API with a key,
// and the egress proxy still refuses anything outside the owner's private network.
export async function probeLocalServer(
  input: LocalProbeInput,
  localTransport: (credential: string | null) => ProviderTransport | null,
): Promise<LocalProbeResult> {
  if ("detect" in input) {
    const attempts = await Promise.allSettled(LOCAL_SERVER_PRESETS.filter((preset) => preset.baseUrl).map(async (preset) => {
      const transport = localTransport(null);
      if (!transport) throw new ModelSettingsError("authenticated_transport_unavailable", 503);
      const signalled: ProviderTransport = (url, init) => transport(url, { ...init, signal: AbortSignal.timeout(DETECT_TIMEOUT_MS) });
      const result = await listWith({ kind: "openai-compatible", baseUrl: preset.baseUrl }, signalled, DETECT_TIMEOUT_MS);
      return { id: preset.id, label: preset.label, baseUrl: preset.baseUrl, ...result };
    }));
    return { servers: attempts.flatMap((attempt) => attempt.status === "fulfilled" ? [attempt.value] : []) };
  }

  let baseUrl: string;
  try { baseUrl = normalizeBaseUrl(input.baseUrl); } catch { throw new ModelSettingsError("invalid_input"); }
  if (isLoopbackModelUrl(baseUrl)) throw new ModelSettingsError("loopback_not_reachable");
  if (!isLocalModelUrl(baseUrl)) throw new ModelSettingsError("not_local_address");
  // The key is used for this one request only; it is not stored and never returned.
  const transport = localTransport(input.apiKey || null);
  if (!transport) throw new ModelSettingsError("authenticated_transport_unavailable", 503);
  return listWith({ kind: "openai-compatible", baseUrl }, transport, PROBE_TIMEOUT_MS);
}
