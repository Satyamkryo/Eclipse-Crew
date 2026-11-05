import "server-only";

import { createProviderConnector } from "../providers";
import { isLocalModelUrl } from "../providers/local";
import { createLocalProxyTransport, createProxyTransport } from "../providers/proxy-transport";
import type { ProviderConnector, ProviderTransport } from "../providers/types";
import { decryptSecret } from "../security/encryption";
import type { StoredProvider } from "./data";

// Local servers on one consumer GPU (or a CPU) need far longer than hosted APIs. 120 s is the connector maximum;
// the egress proxy's local route waits slightly longer so the app reports the timeout first.
export const LOCAL_PROVIDER_TIMEOUT_MS = 120_000;
// Hosted reasoning models (Muse Spark with a long task and a screenshot) can think for longer than the 30 s library
// default. Timeouts are never retried (the provider may still bill the call), so allow up to just under the egress
// proxy's own 60 s cap for one call.
export const HOSTED_PROVIDER_TIMEOUT_MS = 55_000;

// A self-hosted OpenAI-compatible server on this computer, the LAN or Tailscale (Ollama, LM Studio, llama.cpp,
// vLLM, SGLang, a local SAM server). Meta is never local.
export function isLocalProvider(provider: Pick<StoredProvider, "kind" | "baseUrl">): boolean {
  return provider.kind === "openai-compatible" && isLocalModelUrl(provider.baseUrl);
}

// Builds the authenticated transport for a saved provider. Hosted providers need a saved key and use the public
// HTTPS route. Local providers use the proxy's private-network route; their key is optional. Returns null when the
// transport cannot be built; callers report that as "authenticated transport unavailable" or "no model".
export function proxyTransportFor(provider: StoredProvider): ProviderTransport | null {
  try {
    if (isLocalProvider(provider)) {
      return createLocalProxyTransport({ credential: provider.encryptedKey ? decryptSecret(provider.encryptedKey) : null });
    }
    if (!provider.encryptedKey) return null;
    return createProxyTransport({ credential: decryptSecret(provider.encryptedKey) });
  } catch {
    return null;
  }
}

// One place that turns a saved provider plus its transport into a connector, so every caller (chat runs, memory
// jobs, skill drafts) gets the same timeouts.
export function connectorForProvider(provider: StoredProvider, transport: ProviderTransport): ProviderConnector {
  const timeoutMs = isLocalProvider(provider) ? LOCAL_PROVIDER_TIMEOUT_MS : HOSTED_PROVIDER_TIMEOUT_MS;
  return createProviderConnector(provider.kind === "meta"
    ? { kind: "meta", transport, timeoutMs }
    : { kind: "openai-compatible", baseUrl: provider.baseUrl ?? "", transport, timeoutMs });
}
