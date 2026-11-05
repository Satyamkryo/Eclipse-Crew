import "server-only";

import type { getDatabase } from "../../db/client";
import { createModelSettingsStore } from "../models/data";
import type { StoredProvider } from "../models/data";
import { connectorForProvider, isLocalProvider, proxyTransportFor } from "../models/transport";
import type { ProviderConnector } from "../providers/types";

type Database = Awaited<ReturnType<typeof getDatabase>>;

export interface MemoryModel {
  connector: ProviderConnector;
  model: string;
  providerId: string;
  kind: "meta" | "openai-compatible";
  baseUrl: string | null;
}

// TASK-086. The Background role when set, otherwise Main. Calls still go through the egress proxy and the saved key
// never leaves the server; a missing model or key makes the job skip rather than guess.
export async function resolveMemoryModel(database: Database, ownerId: string): Promise<MemoryModel | null> {
  const settings = await createModelSettingsStore(database).load(ownerId);
  const background = settings.background;
  // Hosted providers need a saved key; a local server may run without one.
  const ready = (provider: StoredProvider | null | undefined): provider is StoredProvider =>
    Boolean(provider && (provider.encryptedKey || isLocalProvider(provider)));
  const role = background?.mode === "active" && background.model && ready(background.provider)
    ? background
    : settings.main;
  const provider = role?.provider;
  if (!role?.model || !ready(provider)) return null;
  const transport = proxyTransportFor(provider);
  if (!transport) return null;
  try {
    const connector = connectorForProvider(provider, transport);
    return { connector, model: role.model, providerId: provider.id, kind: provider.kind, baseUrl: provider.baseUrl };
  } catch { return null; }
}
