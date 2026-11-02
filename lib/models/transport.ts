import "server-only";

import { createProxyTransport } from "../providers/proxy-transport";
import type { ProviderTransport } from "../providers/types";
import { decryptSecret } from "../security/encryption";
import type { StoredProvider } from "./data";

// Builds the authenticated transport for a saved provider. Returns null when no key is saved, or when the
// saved key or proxy secret cannot be used; callers report that as "authenticated transport unavailable".
export function proxyTransportFor(provider: StoredProvider): ProviderTransport | null {
  if (!provider.encryptedKey) return null;
  try {
    return createProxyTransport({ credential: decryptSecret(provider.encryptedKey) });
  } catch {
    return null;
  }
}
