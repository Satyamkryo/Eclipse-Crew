import "server-only";

import { ProviderError } from "./errors";
import type {
  CapabilityProfile,
  CapabilitySource,
  CapabilityState,
  CapabilityValue,
  ProviderConnector,
  ProviderKind,
  ProviderModel,
  GenerateRequest,
} from "./types";

const PROBE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZfJ8AAAAASUVORK5CYII=";

interface KnownMediaProfile {
  video: CapabilityValue;
  audio: CapabilityValue;
  computerUse: CapabilityValue;
  contextTokens: number;
}

function value(state: CapabilityState, source: CapabilitySource): CapabilityValue {
  return { state, source };
}

function knownMetaProfile(model: string): KnownMediaProfile | null {
  if (model.startsWith("muse-spark-1.3")) {
    return {
      video: value("supported", "known_profile"),
      audio: value("degraded", "known_profile"),
      computerUse: value("supported", "known_profile"),
      contextTokens: 1_048_576,
    };
  }
  if (model.startsWith("muse-spark-1.2")) {
    return {
      video: value("supported", "known_profile"),
      audio: value("supported", "known_profile"),
      computerUse: value("unsupported", "known_profile"),
      contextTokens: 1_048_576,
    };
  }
  if (model.startsWith("muse-wonder-1.0")) {
    return {
      video: value("supported", "known_profile"),
      audio: value("supported", "known_profile"),
      computerUse: value("supported", "known_profile"),
      contextTokens: 1_048_576,
    };
  }
  return null;
}

function metadataValue(modalities: string[] | null, modality: string): CapabilityValue {
  if (!modalities) return value("unknown", null);
  return modalities.includes(modality)
    ? value("supported", "provider_metadata")
    : value("unknown", null);
}

async function probeToolCalling(connector: ProviderConnector, model: string): Promise<CapabilityValue> {
  const request: GenerateRequest = {
    model,
    messages: [{
      role: "user",
      content: [{ type: "text", text: "Call the eclipse_probe tool with no arguments.", sourceTag: "user" }],
    }],
    tools: [{
      name: "eclipse_probe",
      description: "Capability probe with no side effects.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    }],
    toolChoice: { name: "eclipse_probe" },
    maxOutputTokens: 64,
    reasoningEffort: "minimal",
  };

  try {
    const result = await connector.generate(request);
    if (result.status !== "completed") return value("unknown", "probe");
    const supported = result.outputs.some(
      (output) => output.type === "function_call" && output.name === "eclipse_probe",
    );
    return value(supported ? "supported" : "unsupported", "probe");
  } catch {
    return value("unknown", "probe");
  }
}

async function probeVision(connector: ProviderConnector, model: string): Promise<CapabilityValue> {
  try {
    const result = await connector.generate({
      model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Return the single word vision if this image is visible.", sourceTag: "user" },
          { type: "image", mediaType: "image/png", base64: PROBE_PNG, sourceTag: "user" },
        ],
      }],
      maxOutputTokens: 16,
      reasoningEffort: "minimal",
    });
    if (result.status !== "completed") return value("unknown", "probe");
    return value(/^vision[.!]?$/i.test(result.text.trim()) ? "supported" : "unsupported", "probe");
  } catch {
    return value("unknown", "probe");
  }
}

async function listModelsQuietly(connector: ProviderConnector): Promise<ProviderModel[]> {
  try {
    return await connector.listModels();
  } catch {
    return [];
  }
}

export async function detectProviderCapabilities(
  connector: ProviderConnector,
  kind: ProviderKind,
  model: string,
): Promise<CapabilityProfile> {
  const [models, toolCalling, vision] = await Promise.all([
    listModelsQuietly(connector),
    probeToolCalling(connector, model),
    probeVision(connector, model),
  ]);
  const metadata = models.find((entry) => entry.id === model);
  const known = kind === "meta" ? knownMetaProfile(model) : null;
  const contextTokens = known?.contextTokens ?? metadata?.contextTokens ?? null;
  const contextSource = known
    ? "known_profile"
    : metadata?.contextTokens !== null && metadata?.contextTokens !== undefined
      ? "provider_metadata"
      : null;

  return {
    model,
    toolCalling,
    vision,
    video: known?.video ?? metadataValue(metadata?.inputModalities ?? null, "video"),
    audio: known?.audio ?? metadataValue(metadata?.inputModalities ?? null, "audio"),
    computerUse: known?.computerUse ?? value("unknown", null),
    contextTokens,
    contextSource,
    agentEligible: toolCalling.state === "supported",
  };
}

export function assertAgentCapable(profile: CapabilityProfile): void {
  if (profile.toolCalling.state === "supported") return;
  if (profile.toolCalling.state === "unsupported") {
    throw new ProviderError("tool_calling_unsupported");
  }
  throw new ProviderError("tool_calling_unknown");
}
