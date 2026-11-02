import "server-only";

import { createProviderConnector } from "../providers";
import type { ProviderTransport } from "../providers/types";
import type { ModelSettingsStore, StoredProvider } from "./data";
import type { ModelRole } from "./schema";
import { ModelSettingsError } from "./errors";

const MAX_TEST_MODELS = 200;

export type ModelTestResult = {
  models: Array<{ id: string; contextTokens: number | null }>;
  latencyMs: number;
};

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
  if (!selected?.model || !provider || (role === "sam" && selected.mode !== "meta")) {
    throw new ModelSettingsError("role_not_configured");
  }

  const effective = typeof transport === "function" ? transport : transportFor?.(provider);
  if (typeof effective !== "function") {
    throw new ModelSettingsError("authenticated_transport_unavailable", 503);
  }
  let connector;
  try {
    connector = createProviderConnector(provider.kind === "meta"
      ? { kind: "meta", transport: effective }
      : { kind: "openai-compatible", baseUrl: provider.baseUrl ?? "", transport: effective });
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
