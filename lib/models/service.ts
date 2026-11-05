import "server-only";

import { encryptSecret } from "../security/encryption";
import { keyHint } from "../security/key-hint";
import { normalizeBaseUrl } from "../providers/transport";
import { isLocalModelUrl, isLoopbackModelUrl } from "../providers/local";
import type { ModelSettingsStore, StoredModelRole, StoredProvider } from "./data";
import { ModelSettingsError } from "./errors";
import {
  MAIN_MODEL,
  mainModelSettingsSchema,
  samModelSettingsSchema,
  type MainModelSettingsInput,
  type SamModelSettingsInput,
} from "./schema";
import type { BackgroundModelSettingsInput } from "./schema";

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
  mode: "off" | "meta" | "local";
  // Local SAM server address (mode "local" only).
  baseUrl: string | null;
  useMainKey: boolean;
  hasKey: boolean;
  keyHint: string | null;
  canUseMainKey: boolean;
};

// TASK-086. Optional: an unset background role makes memory jobs use Main.
export type BackgroundModelSettings = {
  configured: boolean;
  kind: "meta" | "openai-compatible";
  baseUrl: string | null;
  model: string;
  hasKey: boolean;
  keyHint: string | null;
};

export type ModelSettings = {
  main: MainModelSettings;
  sam: SamModelSettings;
  background: BackgroundModelSettings;
};

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
  const mode = sam?.mode === "meta" ? "meta" : sam?.mode === "local" ? "local" : "off";
  const mainHasKey = Boolean(main?.provider?.kind === "meta" && main.provider.encryptedKey);
  const provider = sam?.useMainKey ? main?.provider : sam?.provider;
  return {
    configured: mode !== "off" && Boolean(provider),
    mode,
    baseUrl: mode === "local" ? provider?.baseUrl ?? null : null,
    useMainKey: mode === "meta" && Boolean(sam?.useMainKey),
    hasKey: mode !== "off" && Boolean(provider?.encryptedKey),
    keyHint: mode !== "off" ? provider?.keyHint ?? null : null,
    canUseMainKey: mainHasKey,
  };
}

function backgroundView(role: StoredModelRole | null): BackgroundModelSettings {
  return {
    configured: Boolean(role?.provider && role.model),
    kind: role?.provider?.kind ?? "meta",
    baseUrl: role?.provider?.baseUrl ?? null,
    model: role?.model ?? MAIN_MODEL,
    hasKey: Boolean(role?.provider?.encryptedKey),
    keyHint: role?.provider?.keyHint ?? null,
  };
}

function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try { return new URL(value).origin; } catch { return null; }
}

// Normalizes an OpenAI-compatible address and explains the one mistake that can never work: inside Docker,
// localhost is the Eclipse Crew container, not the owner's computer.
function compatibleBaseUrl(value: string | undefined): string {
  let normalized: string;
  try { normalized = normalizeBaseUrl(value); } catch { throw new ModelSettingsError("invalid_input"); }
  if (isLoopbackModelUrl(normalized)) throw new ModelSettingsError("loopback_not_reachable");
  return normalized;
}

// A saved key is reused only for the same kind of provider at the same origin; any other destination needs it
// pasted again, so a key is never sent somewhere it was not entered for.
function keyCarriesOver(existing: StoredProvider | null | undefined, kind: StoredProvider["kind"], baseUrl: string | null): boolean {
  if (!existing?.encryptedKey || existing.kind !== kind) return false;
  return kind === "meta" || originOf(existing.baseUrl) === originOf(baseUrl);
}

export async function readModelSettings(store: ModelSettingsStore, ownerId: string): Promise<ModelSettings> {
  const stored = await store.load(ownerId);
  return { main: mainView(stored.main), sam: samView(stored.main, stored.sam), background: backgroundView(stored.background) };
}

// TASK-086. Background memory jobs use this role when it is set, otherwise Main.
export async function saveBackgroundSettings(
  store: ModelSettingsStore, ownerId: string, input: BackgroundModelSettingsInput,
): Promise<ModelSettings> {
  if (!input.enabled) {
    await store.saveBackground(ownerId, { mode: "off" });
    return readModelSettings(store, ownerId);
  }
  const baseUrl = input.kind === "openai-compatible" ? compatibleBaseUrl(input.baseUrl) : null;
  const apiKey = input.apiKey || undefined;
  const existing = (await store.load(ownerId)).background?.provider;
  const keeps = keyCarriesOver(existing, input.kind, baseUrl);
  // Hosted providers need a key; a local server (Ollama, LM Studio, llama.cpp, vLLM) may run without one.
  if (!apiKey && !keeps && !(input.kind === "openai-compatible" && isLocalModelUrl(baseUrl))) {
    throw new ModelSettingsError("key_required");
  }
  let encrypted;
  try { encrypted = encryptedFields(apiKey); } catch { throw new ModelSettingsError("encryption_unavailable", 503); }
  await store.saveBackground(ownerId, {
    mode: "active", kind: input.kind, baseUrl, model: input.model, ...(apiKey ? encrypted : keeps ? {} : { clearKey: true }),
  });
  return readModelSettings(store, ownerId);
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

  const normalizedBaseUrl = value.kind === "openai-compatible" ? compatibleBaseUrl(value.baseUrl) : null;

  const apiKey = value.apiKey || undefined;
  const keeps = keyCarriesOver(existing.main?.provider, value.kind, normalizedBaseUrl);
  // Hosted providers need a key; a local server (Ollama, LM Studio, llama.cpp, vLLM) may run without one.
  const local = value.kind === "openai-compatible" && isLocalModelUrl(normalizedBaseUrl);
  if (!apiKey && !keeps && !local) {
    throw new ModelSettingsError("key_required");
  }

  await store.saveMain(ownerId, {
    kind: value.kind,
    baseUrl: normalizedBaseUrl,
    model: value.model,
    routing: value.routing,
    hardModel: value.routing === "auto" ? value.hardModel ?? null : null,
    ...(apiKey ? encryptedFields(apiKey) : keeps ? {} : { clearKey: true }),
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

  if (value.mode === "local") {
    const baseUrl = compatibleBaseUrl(value.baseUrl);
    const apiKey = value.apiKey || undefined;
    const previous = existing.sam && !existing.sam.useMainKey ? existing.sam.provider : null;
    const keeps = keyCarriesOver(previous, "openai-compatible", baseUrl);
    // A SAM server on this computer, the LAN or Tailscale may run without a key; one on the internet needs it.
    if (!apiKey && !keeps && !isLocalModelUrl(baseUrl)) throw new ModelSettingsError("key_required");
    await store.saveSam(ownerId, { mode: "local", baseUrl, model: "sam-3.1", ...encryptedFields(apiKey) });
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
  // Only a Meta key saved for SAM itself carries over; a local server's key is never sent to Meta.
  const existingOwnKey = existing.sam?.mode === "meta" && !existing.sam.useMainKey && existing.sam.provider?.kind === "meta"
    ? existing.sam.provider.encryptedKey
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
