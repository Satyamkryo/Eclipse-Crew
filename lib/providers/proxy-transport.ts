import "server-only";

import { requireEgressProxySecret } from "../config/server";
import type { ProviderTransport } from "./types";

export const EGRESS_PROXY_URL = "http://egress-proxy:4320";
const FORWARDED_HEADERS = ["content-type", "accept"] as const;

// Sends provider requests through the egress proxy, which adds the API key. The key travels in a header
// to the proxy only; it never enters a prompt, a response, a log or the browser. Callers cannot set
// authorization headers of their own, and only public https targets are allowed.
export function createProxyTransport(options: {
  credential: string;
  secret?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): ProviderTransport {
  const secret = requireEgressProxySecret(options.secret ?? process.env.EGRESS_PROXY_SECRET);
  const baseUrl = options.baseUrl ?? EGRESS_PROXY_URL;
  const send = options.fetchImpl ?? fetch;
  if (!/^[\x21-\x7e]{8,4096}$/.test(options.credential)) throw new Error("invalid_credential");

  return async (url, init) => {
    const target = new URL(String(url));
    if (target.protocol !== "https:" || target.username || target.password) throw new Error("egress_target_not_allowed");
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") throw new Error("egress_method_not_allowed");
    if (init?.body !== undefined && init.body !== null && typeof init.body !== "string") throw new Error("egress_body_not_allowed");

    const source = new Headers(init?.headers);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${secret}`,
      "X-Eclipse-Target": target.href,
      "X-Eclipse-Method": method,
      "X-Eclipse-Credential": options.credential,
    };
    for (const name of FORWARDED_HEADERS) {
      const value = source.get(name);
      if (value) headers[name] = value;
    }

    const response = await send(`${baseUrl}/v1/forward`, {
      method: "POST",
      headers,
      body: method === "POST" ? (init?.body as string | undefined) : undefined,
      redirect: "error",
      signal: init?.signal,
    });
    // Proxy-level failures (bad secret, blocked target, timeout) are not provider answers.
    if (response.headers.get("x-eclipse-proxy") !== "ok") {
      await response.body?.cancel();
      throw new Error("egress_proxy_error");
    }
    return response;
  };
}

// Local model servers (Ollama, LM Studio, llama.cpp, vLLM, self-hosted SAM). Same contract as createProxyTransport,
// but through /v1/local-forward: plain HTTP is allowed, the key is optional, and the proxy only connects when the
// target resolves to the owner's private network. A key, when set, still travels only to the proxy.
export function createLocalProxyTransport(options: {
  credential?: string | null;
  secret?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): ProviderTransport {
  const secret = requireEgressProxySecret(options.secret ?? process.env.EGRESS_PROXY_SECRET);
  const baseUrl = options.baseUrl ?? EGRESS_PROXY_URL;
  const send = options.fetchImpl ?? fetch;
  const credential = options.credential || null;
  if (credential !== null && !/^[\x21-\x7e]{8,4096}$/.test(credential)) throw new Error("invalid_credential");

  return async (url, init) => {
    const target = new URL(String(url));
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.hash) {
      throw new Error("egress_target_not_allowed");
    }
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") throw new Error("egress_method_not_allowed");
    if (init?.body !== undefined && init.body !== null && typeof init.body !== "string") throw new Error("egress_body_not_allowed");

    const source = new Headers(init?.headers);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${secret}`,
      "X-Eclipse-Target": target.href,
      "X-Eclipse-Method": method,
      ...(credential ? { "X-Eclipse-Credential": credential } : {}),
    };
    for (const name of FORWARDED_HEADERS) {
      const value = source.get(name);
      if (value) headers[name] = value;
    }

    const response = await send(`${baseUrl}/v1/local-forward`, {
      method: "POST",
      headers,
      body: method === "POST" ? (init?.body as string | undefined) : undefined,
      redirect: "error",
      signal: init?.signal,
    });
    if (response.headers.get("x-eclipse-proxy") !== "ok") {
      await response.body?.cancel();
      throw new Error("egress_proxy_error");
    }
    return response;
  };
}

// Dedicated fixed-destination ASR. Generic ProviderTransport remains string-only.
export function createAudioProxyTransport(options: {
  credential: string; secret?: string; baseUrl?: string; fetchImpl?: typeof fetch;
}) {
  const secret = requireEgressProxySecret(options.secret ?? process.env.EGRESS_PROXY_SECRET);
  if (!/^[\x21-\x7e]{8,4096}$/.test(options.credential)) throw new Error("invalid_credential");
  return async (wav: Uint8Array) => {
    if (!wav.byteLength || wav.byteLength > 3 * 1024 * 1024) throw new Error("invalid_audio");
    return (options.fetchImpl ?? fetch)((options.baseUrl ?? EGRESS_PROXY_URL) + "/v1/teach-asr", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
      headers: { Authorization: "Bearer " + secret, "X-Eclipse-Credential": options.credential, "Content-Type": "audio/wav", Accept: "application/json" },
      body: new Uint8Array(wav),
    });
  };
}
