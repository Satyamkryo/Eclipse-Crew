import "server-only";

import { createMetaConnector } from "./meta";
import { createOpenAICompatibleConnector } from "./openai-compatible";
import { ProviderError } from "./errors";
import { normalizeBaseUrl, resolveRuntimeLimits } from "./transport";
import type {
  MetaProviderConfig,
  OpenAICompatibleConfig,
  ProviderConfig,
  ProviderConnector,
  ProviderTransport,
} from "./types";

function asRecord(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new ProviderError("invalid_config");
  }
  return config as Record<string, unknown>;
}

function rejectUnknown(record: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new ProviderError("invalid_config");
  }
}

export function createProviderConnector(config: ProviderConfig): ProviderConnector;
export function createProviderConnector(config: unknown): ProviderConnector;
export function createProviderConnector(config: unknown): ProviderConnector {
  const record = asRecord(config);
  const kind = record.kind;
  if (typeof record.transport !== "function") throw new ProviderError("invalid_config");
  const transport = record.transport as ProviderTransport;

  if (kind === "meta") {
    rejectUnknown(record, ["kind", "transport", "timeoutMs", "maxResponseBytes"]);
    const metaConfig: MetaProviderConfig = {
      kind,
      transport,
      ...(typeof record.timeoutMs === "number" ? { timeoutMs: record.timeoutMs } : {}),
      ...(typeof record.maxResponseBytes === "number" ? { maxResponseBytes: record.maxResponseBytes } : {}),
    };
    if (record.timeoutMs !== undefined && typeof record.timeoutMs !== "number") {
      throw new ProviderError("invalid_config");
    }
    if (record.maxResponseBytes !== undefined && typeof record.maxResponseBytes !== "number") {
      throw new ProviderError("invalid_config");
    }
    return createMetaConnector(metaConfig, resolveRuntimeLimits(metaConfig));
  }

  if (kind === "openai-compatible") {
    rejectUnknown(record, ["kind", "baseUrl", "transport", "timeoutMs", "maxResponseBytes"]);
    const baseUrl = normalizeBaseUrl(record.baseUrl);
    if (record.timeoutMs !== undefined && typeof record.timeoutMs !== "number") {
      throw new ProviderError("invalid_config");
    }
    if (record.maxResponseBytes !== undefined && typeof record.maxResponseBytes !== "number") {
      throw new ProviderError("invalid_config");
    }
    const openAIConfig: OpenAICompatibleConfig = {
      kind,
      baseUrl,
      transport,
      ...(typeof record.timeoutMs === "number" ? { timeoutMs: record.timeoutMs } : {}),
      ...(typeof record.maxResponseBytes === "number" ? { maxResponseBytes: record.maxResponseBytes } : {}),
    };
    return createOpenAICompatibleConnector(openAIConfig, resolveRuntimeLimits(openAIConfig));
  }

  throw new ProviderError("invalid_config");
}

export { ProviderError } from "./errors";
export { assertAgentCapable } from "./capabilities";
export type * from "./types";
