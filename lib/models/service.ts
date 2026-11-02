import "server-only";

import { encryptSecret } from "../security/encryption";
import { normalizeBaseUrl } from "../providers/transport";
import type { ModelSettingsStore, StoredModelRole } from "./data";
import { ModelSettingsError } from "./errors";
import {
  MAIN_MODEL,
  mainModelSettingsSchema,
  samModelSettingsSchema,
  type MainModelSettingsInput,
  type SamModelSettingsInput,
} from "./schema";

export type MainModelSettings = {
  configured: boolean;
  kind: "meta" | "openai-compatible";
  baseUrl: string | null;
  model: string;
  hasKey: boolean;
  keyHint: string | null;
  routing: "fixed" | "auto";
  hardModel: string | null;
};

export type SamModelSettings = {
  configured: boolean;
  mode: "off" | "meta";
  useMainKey: boolean;
  hasKey: boolean;
  keyHint: string | null;
  canUseMainKey: boolean;
};

export type ModelSettings = {
  main: MainModelSettings;
  sam: SamModelSettings;
};

function keyHint(apiKey: string): string {
  const characters = Array.from(apiKey);
  return `••••${characters.length > 4 ? characters.slice(-4).join("") : ""}`;
}

function encryptedFields(apiKey: string | undefined) {
  if (!apiKey) return {};
  try {
    return { encryptedKey: encryptSecret(apiKey), keyHint: keyHint(apiKey) };
  } catch {
    throw new ModelSettingsError("encryption_unavailable", 503);
  }
}

function mainView(main: StoredModelRole | null): MainModelSettings {
  return {
    configured: Boolean(main?.provider && main.model),
    kind: main?.provider?.kind ?? "meta",
    baseUrl: main?.provider?.baseUrl ?? null,
    model: main?.model ?? MAIN_MODEL,
    hasKey: Boolean(main?.provider?.encryptedKey),
    keyHint: main?.provider?.keyHint ?? null,
    routing: main?.routing === "auto" && main.hardModel ? "auto" : "fixed",
    hardModel: main?.routing === "auto" ? main.hardModel : null,
  };
}

function samView(main: StoredModelRole | null, sam: StoredModelRole | null): SamModelSettings {
  const mode = sam?.mode === "meta" ? "meta" : "off";
  const mainHasKey = Boolean(main?.provider?.kind === "meta" && main.provider.encryptedKey);
  const provider = sam?.useMainKey ? main?.provider : sam?.provider;
  return {
    configured: mode === "meta" && Boolean(provider),
    mode,
    useMainKey: Boolean(sam?.useMainKey),
    hasKey: mode === "meta" && Boolean(provider?.encryptedKey),
    keyHint: mode === "meta" ? provider?.keyHint ?? null : null,
    canUseMainKey: mainHasKey,
  };
}

export async function readModelSettings(store: ModelSettingsStore, ownerId: string): Promise<ModelSettings> {
  const stored = await store.load(ownerId);
  return { main: mainView(stored.main), sam: samView(stored.main, stored.sam) };
}

export async function saveMainSettings(
  store: ModelSettingsStore,
  ownerId: string,
  input: MainModelSettingsInput,
): Promise<ModelSettings> {
  const parsed = mainModelSettingsSchema.safeParse(input);
  if (!parsed.success) throw new ModelSettingsError("invalid_input");
  const value = parsed.data;
  const existing = await store.load(ownerId);

  if (existing.sam?.useMainKey && value.kind !== "meta") {
    throw new ModelSettingsError("sam_depends_on_main_key", 409);
  }

  let normalizedBaseUrl: string | null = null;
  if (value.kind === "openai-compatible" && value.baseUrl) {
    try {
      normalizedBaseUrl = normalizeBaseUrl(value.baseUrl);
    } catch {
      throw new ModelSettingsError("invalid_input");
    }
  }

  const apiKey = value.apiKey || undefined;
  const existingMetaKey = existing.main?.provider?.kind === "meta" && existing.main.provider.encryptedKey;
  if (value.kind === "meta" && !apiKey && !existingMetaKey) {
    throw new ModelSettingsError("key_required");
  }

  const providerChanged = Boolean(existing.main?.provider && existing.main.provider.kind !== value.kind);
  await store.saveMain(ownerId, {
    kind: value.kind,
    baseUrl: normalizedBaseUrl,
    model: value.model,
    routing: value.routing,
    hardModel: value.routing === "auto" ? value.hardModel ?? null : null,
    ...(providerChanged && !apiKey ? { clearKey: true } : encryptedFields(apiKey)),
  });
  return readModelSettings(store, ownerId);
}

export async function saveSamSettings(
  store: ModelSettingsStore,
  ownerId: string,
  input: SamModelSettingsInput,
): Promise<ModelSettings> {
  const parsed = samModelSettingsSchema.safeParse(input);
  if (!parsed.success) throw new ModelSettingsError("invalid_input");
  const value = parsed.data;
  const existing = await store.load(ownerId);

  if (value.mode === "off") {
    await store.saveSam(ownerId, { mode: "off" });
    return readModelSettings(store, ownerId);
  }

  const mainHasKey = Boolean(existing.main?.provider?.kind === "meta" && existing.main.provider.encryptedKey);
  if (value.useMainKey) {
    if (!mainHasKey) throw new ModelSettingsError("main_key_required");
    await store.saveSam(ownerId, {
      mode: "meta", useMainKey: true, model: "sam-3.1",
    });
    return readModelSettings(store, ownerId);
  }

  const apiKey = value.apiKey || undefined;
  const existingOwnKey = existing.sam && !existing.sam.useMainKey
    ? existing.sam.provider?.encryptedKey
    : null;
  if (!apiKey && !existingOwnKey) throw new ModelSettingsError("key_required");
  await store.saveSam(ownerId, {
    mode: "meta",
    useMainKey: false,
    model: "sam-3.1",
    ...encryptedFields(apiKey),
  });
  return readModelSettings(store, ownerId);
}
