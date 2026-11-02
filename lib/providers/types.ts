import "server-only";

export type ProviderKind = "meta" | "openai-compatible";
export type ProviderSourceTag = "user" | "agent" | "web" | "email" | "document" | "tool";
export type ProviderReasoningEffort = "minimal" | "low" | "medium" | "high" | "max";
export type ProviderImageMediaType = "image/png" | "image/jpeg" | "image/webp";

export interface ProviderTextContent {
  type: "text";
  text: string;
  sourceTag: ProviderSourceTag;
}

export interface ProviderImageContent {
  type: "image";
  mediaType: ProviderImageMediaType;
  base64: string;
  sourceTag: ProviderSourceTag;
}

export type ProviderContent = ProviderTextContent | ProviderImageContent;

export interface ProviderMessage {
  role: "user" | "assistant";
  content: ProviderContent[];
}

export interface ProviderTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ProviderToolChoice = "auto" | "required" | { name: string };

export interface GenerateRequest {
  model: string;
  instructions?: string;
  messages: ProviderMessage[];
  tools?: ProviderTool[];
  toolChoice?: ProviderToolChoice;
  maxOutputTokens?: number;
  reasoningEffort?: ProviderReasoningEffort;
  computerUse?: boolean;
  signal?: AbortSignal;
}

export interface ProviderModel {
  id: string;
  contextTokens: number | null;
  inputModalities: string[] | null;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
}

export interface ProviderSafetyCheck {
  id: string;
  code?: string | null;
  message?: string | null;
}

export interface ProviderMessageOutput {
  type: "message";
  text: string;
}

export interface ProviderFunctionCallOutput {
  type: "function_call";
  callId: string;
  name: string;
  arguments: string;
}

export interface ProviderComputerCallOutput {
  type: "computer_call";
  callId: string;
  actions: Record<string, unknown>[];
  pendingSafetyChecks: ProviderSafetyCheck[];
  replayItems: Record<string, unknown>[];
}

export type ProviderOutput =
  | ProviderMessageOutput
  | ProviderFunctionCallOutput
  | ProviderComputerCallOutput;

export type ProviderResultStatus = "completed" | "incomplete" | "safety_review_required";

export interface ProviderResult {
  id: string | null;
  model: string;
  status: ProviderResultStatus;
  incompleteReason: "max_output_tokens" | "content_filter" | "other" | null;
  outputs: ProviderOutput[];
  text: string;
  usage: ProviderUsage;
}

export interface ComputerContinuation {
  request: GenerateRequest;
  result: ProviderResult;
  screenshot: { mediaType: "image/png"; base64: string };
  acknowledgedSafetyChecks: ProviderSafetyCheck[];
}

export type ProviderTransport = (url: string, init: RequestInit) => Promise<Response>;

export interface ProviderRuntimeOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export type MetaProviderConfig = ProviderRuntimeOptions & {
  kind: "meta";
  transport: ProviderTransport;
};

export type OpenAICompatibleConfig = ProviderRuntimeOptions & {
  kind: "openai-compatible";
  baseUrl: string;
  transport: ProviderTransport;
};

export type ProviderConfig = MetaProviderConfig | OpenAICompatibleConfig;

export type CapabilityState = "supported" | "unsupported" | "degraded" | "unknown";
export type CapabilitySource = "probe" | "provider_metadata" | "known_profile" | null;

export interface CapabilityValue {
  state: CapabilityState;
  source: CapabilitySource;
}

export interface CapabilityProfile {
  model: string;
  toolCalling: CapabilityValue;
  vision: CapabilityValue;
  video: CapabilityValue;
  audio: CapabilityValue;
  computerUse: CapabilityValue;
  contextTokens: number | null;
  contextSource: Exclude<CapabilitySource, "probe">;
  agentEligible: boolean;
}

export interface ProviderConnector {
  readonly kind: ProviderKind;
  listModels(): Promise<ProviderModel[]>;
  generate(request: GenerateRequest): Promise<ProviderResult>;
  detectCapabilities(model: string): Promise<CapabilityProfile>;
  continueComputer?(continuation: ComputerContinuation): Promise<ProviderResult>;
}
