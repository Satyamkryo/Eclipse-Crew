import "server-only";

import { z } from "zod";

import { sourceTagSchema } from "../security/source-tags";
import { ProviderError, providerHttpError } from "./errors";
import type { GenerateRequest, ProviderImageMediaType, ProviderRuntimeOptions, ProviderTransport } from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const sourceTag = sourceTagSchema;
const imageBase64 = z.string().min(4).max(7_000_000).refine((value) => {
  try {
    const bytes = Buffer.from(value, "base64");
    return bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES && bytes.toString("base64") === value;
  } catch {
    return false;
  }
});
const contentSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string().min(1).max(1_000_000),
    sourceTag,
  }).strict(),
  z.object({
    type: z.literal("image"),
    mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    base64: imageBase64,
    sourceTag,
  }).strict(),
]);
const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.array(contentSchema).min(1).max(64),
}).strict();
const toolSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[A-Za-z_][A-Za-z0-9_-]*$/),
  description: z.string().max(8192),
  parameters: z.record(z.string(), z.unknown()),
}).strict();
const requestSchema = z.object({
  model: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
  instructions: z.string().min(1).max(100_000).optional(),
  messages: z.array(messageSchema).min(1).max(256),
  tools: z.array(toolSchema).max(64).optional(),
  toolChoice: z.union([
    z.enum(["auto", "required"]),
    z.object({ name: z.string().min(1).max(64).regex(/^[A-Za-z_][A-Za-z0-9_-]*$/) }).strict(),
  ]).optional(),
  maxOutputTokens: z.number().int().min(1).max(1_000_000).optional(),
  reasoningEffort: z.enum(["minimal", "low", "medium", "high", "max"]).optional(),
  computerUse: z.boolean().optional(),
  signal: z.instanceof(AbortSignal).optional(),
}).strict();

export function validateGenerateRequest(request: unknown): GenerateRequest {
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success) throw new ProviderError("invalid_request");
  return parsed.data;
}

export function assertImageBase64(value: string, mediaType: ProviderImageMediaType): void {
  const parsed = z.string().min(4).max(7_000_000).safeParse(value);
  if (!parsed.success) throw new ProviderError("invalid_request");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== value) {
    throw new ProviderError("invalid_request");
  }
  if (mediaType === "image/png" && !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new ProviderError("invalid_request");
  }
}

export function taggedText(text: string, tag: string): string {
  return `SOURCE_TAG=${tag}; CONTENT_JSON=${JSON.stringify(text)}`;
}

export function taggedImageLabel(tag: string): string {
  return taggedText("image follows.", tag);
}

export function imageDataUrl(mediaType: string, base64: string): string {
  return `data:${mediaType};base64,${base64}`;
}

export interface RuntimeLimits {
  timeoutMs: number;
  maxResponseBytes: number;
}

export function resolveRuntimeLimits(options: ProviderRuntimeOptions = {}): RuntimeLimits {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 120_000) {
    throw new ProviderError("invalid_config");
  }
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 64 || maxResponseBytes > 16 * 1024 * 1024) {
    throw new ProviderError("invalid_config");
  }
  return { timeoutMs, maxResponseBytes };
}

export function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim()) throw new ProviderError("invalid_config");
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        url.search || url.hash) throw new Error();
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    throw new ProviderError("invalid_config");
  }
}

export function joinProviderUrl(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

async function readJsonResponse(
  response: Response,
  maxResponseBytes: number,
  setCancel: (cancel: (() => Promise<void>) | undefined) => void,
): Promise<unknown> {
  if (!response.ok) {
    const error = providerHttpError(response.status);
    // Keep only the provider's own short explanation (message/param/code) for operator logs; never shown to the model.
    if (response.status >= 400 && response.status < 500) {
      try {
        const text = (await response.text()).slice(0, 4096);
        const body = JSON.parse(text) as { error?: { message?: unknown; param?: unknown; code?: unknown } | string; message?: unknown };
        const source = typeof body.error === "object" && body.error ? body.error : body;
        const parts = [source.message ?? (typeof body.error === "string" ? body.error : undefined),
          "param" in source ? source.param : undefined, "code" in source ? source.code : undefined]
          .filter((value): value is string => typeof value === "string" && value.length > 0);
        if (parts.length) Object.assign(error, { detail: parts.join(" | ").replace(/\s+/g, " ").slice(0, 300) });
      } catch { /* no readable detail */ }
    } else await response.body?.cancel();
    throw error;
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxResponseBytes) {
    await response.body?.cancel();
    throw new ProviderError("response_too_large");
  }
  if (!response.body) throw new ProviderError("invalid_response");

  const reader = response.body.getReader();
  setCancel(() => reader.cancel());
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) {
        await reader.cancel();
        throw new ProviderError("response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    setCancel(undefined);
    reader.releaseLock();
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    return JSON.parse(text);
  } catch {
    throw new ProviderError("invalid_response");
  }
}

// Transient failures (network reset, 5xx, 429) are retried briefly so one blip does not end a whole run.
const RETRYABLE_CODES = new Set(["network_error", "provider_unavailable", "rate_limited"]);
const RETRY_DELAYS_MS = [800, 2_000];

export async function requestJson(
  transport: ProviderTransport,
  url: string,
  init: RequestInit,
  limits: RuntimeLimits,
): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestJsonOnce(transport, url, init, limits);
    } catch (error) {
      const code = error instanceof ProviderError ? error.code : undefined;
      if (!code || !RETRYABLE_CODES.has(code) || attempt >= RETRY_DELAYS_MS.length || init.signal?.aborted) throw error;
      const waited = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => { init.signal?.removeEventListener("abort", onAbort); resolve(true); }, RETRY_DELAYS_MS[attempt]);
        const onAbort = () => { clearTimeout(timer); resolve(false); };
        init.signal?.addEventListener("abort", onAbort, { once: true });
      });
      if (!waited) throw new ProviderError("aborted");
    }
  }
}

async function requestJsonOnce(
  transport: ProviderTransport,
  url: string,
  init: RequestInit,
  limits: RuntimeLimits,
): Promise<unknown> {
  const body = init.body;
  if (typeof body === "string" && Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
    throw new ProviderError("invalid_request");
  }

  const caller = init.signal;
  if (caller?.aborted) throw new ProviderError("aborted");
  const controller = new AbortController();
  let cancelStream: (() => Promise<void>) | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let onCallerAbort: (() => void) | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    deadline = setTimeout(() => {
      controller.abort();
      if (cancelStream) void cancelStream().catch(() => undefined);
      reject(new ProviderError("timeout"));
    }, limits.timeoutMs);
  });
  const cancelled = new Promise<never>((_, reject) => {
    onCallerAbort = () => {
      controller.abort();
      if (cancelStream) void cancelStream().catch(() => undefined);
      reject(new ProviderError("aborted"));
    };
    caller?.addEventListener("abort", onCallerAbort, { once: true });
  });

  try {
    return await Promise.race([
      (async () => {
        let response: Response;
        try {
          response = await transport(url, { ...init, redirect: "error", signal: controller.signal });
        } catch (error) {
          if (caller?.aborted) throw new ProviderError("aborted");
          if (controller.signal.aborted) throw new ProviderError("timeout");
          if (error instanceof ProviderError) throw error;
          throw new ProviderError("network_error");
        }
        if (caller?.aborted) {
          await response.body?.cancel();
          throw new ProviderError("aborted");
        }
        if (controller.signal.aborted) {
          await response.body?.cancel();
          throw new ProviderError("timeout");
        }
        return readJsonResponse(response, limits.maxResponseBytes, (cancel) => {
          cancelStream = cancel;
        });
      })(),
      timedOut,
      cancelled,
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
    if (onCallerAbort) caller?.removeEventListener("abort", onCallerAbort);
    cancelStream = undefined;
  }
}
