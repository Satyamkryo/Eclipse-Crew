import "server-only";

import { z } from "zod";

import { detectProviderCapabilities } from "./capabilities";
import { ProviderError } from "./errors";
import {
  assertImageBase64,
  imageDataUrl,
  joinProviderUrl,
  requestJson,
  taggedImageLabel,
  taggedText,
  validateGenerateRequest,
  type RuntimeLimits,
} from "./transport";
import type {
  CapabilityProfile,
  GenerateRequest,
  OpenAICompatibleConfig,
  ProviderConnector,
  ProviderModel,
  ProviderOutput,
  ProviderResult,
} from "./types";

const MAX_TEXT = 1024 * 1024;

const modelSchema = z.object({
  id: z.string().min(1).max(200),
  context_length: z.number().int().positive().max(100_000_000).optional(),
  context_window: z.number().int().positive().max(100_000_000).optional(),
  max_context_length: z.number().int().positive().max(100_000_000).optional(),
  architecture: z.object({
    input_modalities: z.array(z.string().min(1).max(64)).max(16),
  }).passthrough().optional(),
}).passthrough();
const modelListSchema = z.object({ data: z.array(modelSchema).max(1000) }).passthrough();

const tokenCount = z.number().int().nonnegative().max(1_000_000_000);
const usageSchema = z.object({
  prompt_tokens: tokenCount,
  completion_tokens: tokenCount,
  prompt_tokens_details: z.object({ cached_tokens: tokenCount }).passthrough().optional(),
  completion_tokens_details: z.object({ reasoning_tokens: tokenCount }).passthrough().optional(),
}).passthrough();

const contentSchema = z.union([
  z.string().max(MAX_TEXT),
  z.null(),
  z.array(z.object({
    type: z.string().min(1).max(64),
    text: z.string().max(MAX_TEXT).optional(),
  }).passthrough()).max(64),
]);
const toolCallSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1).max(64),
    arguments: z.string().max(MAX_TEXT),
  }).passthrough(),
}).passthrough();
const choiceSchema = z.object({
  index: z.number().int().nonnegative().max(15),
  message: z.object({
    role: z.literal("assistant"),
    content: contentSchema.optional(),
    tool_calls: z.array(toolCallSchema).max(16).optional(),
  }).passthrough(),
  finish_reason: z.string().max(64).nullable().optional(),
}).passthrough();
const responseSchema = z.object({
  id: z.string().min(1).max(MAX_TEXT).optional(),
  model: z.string().min(1).max(200).optional(),
  choices: z.array(choiceSchema).min(1).max(16),
  usage: usageSchema,
}).passthrough();

function requestToolChoice(value: GenerateRequest["toolChoice"]): unknown {
  if (value === undefined || value === "auto" || value === "required") return value;
  return { type: "function", function: { name: value.name } };
}

function requestMessages(request: GenerateRequest): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  if (request.instructions !== undefined) {
    messages.push({ role: "system", content: taggedText(request.instructions, "user") });
  }
  for (const message of request.messages) {
    messages.push({
      role: message.role,
      content: message.content.flatMap((content) => {
        if (content.type === "text") {
          return [{ type: "text", text: taggedText(content.text, content.sourceTag) }];
        }
        return [
          { type: "text", text: taggedImageLabel(content.sourceTag) },
          { type: "image_url", image_url: { url: imageDataUrl(content.mediaType, content.base64) } },
        ];
      }),
    });
  }
  return messages;
}

function parseArguments(value: string): void {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
  } catch {
    throw new ProviderError("invalid_response");
  }
}

function parseContent(value: z.infer<typeof contentSchema> | undefined): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return value
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("");
}

function parseResponse(value: unknown, requestedModel: string): ProviderResult {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) throw new ProviderError("invalid_response");
  const choice = parsed.data.choices[0];
  const outputs: ProviderOutput[] = [];
  const text = parseContent(choice.message.content);
  if (text) outputs.push({ type: "message", text });

  for (const call of choice.message.tool_calls ?? []) {
    parseArguments(call.function.arguments);
    outputs.push({
      type: "function_call",
      callId: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    });
  }
  if (!outputs.length) throw new ProviderError("invalid_response");

  const incompleteReason = choice.finish_reason === "length"
    ? "max_output_tokens" as const
    : choice.finish_reason === "content_filter" ? "content_filter" as const : null;

  return {
    id: parsed.data.id ?? null,
    model: parsed.data.model ?? requestedModel,
    status: incompleteReason ? "incomplete" : "completed",
    incompleteReason,
    outputs,
    text,
    usage: {
      inputTokens: parsed.data.usage.prompt_tokens,
      outputTokens: parsed.data.usage.completion_tokens,
      cachedInputTokens: parsed.data.usage.prompt_tokens_details?.cached_tokens ?? 0,
      reasoningTokens: parsed.data.usage.completion_tokens_details?.reasoning_tokens ?? 0,
    },
  };
}

export function createOpenAICompatibleConnector(
  config: OpenAICompatibleConfig,
  limits: RuntimeLimits,
): ProviderConnector {
  const connector: ProviderConnector = {
    kind: "openai-compatible",

    async listModels(): Promise<ProviderModel[]> {
      const value = await requestJson(
        config.transport,
        joinProviderUrl(config.baseUrl, "models"),
        { method: "GET", headers: { Accept: "application/json" } },
        limits,
      );
      const parsed = modelListSchema.safeParse(value);
      if (!parsed.success) throw new ProviderError("invalid_response");
      return parsed.data.data.map((model) => ({
        id: model.id,
        contextTokens: model.context_length ?? model.context_window ?? model.max_context_length ?? null,
        inputModalities: model.architecture?.input_modalities ?? null,
      }));
    },

    async generate(request: GenerateRequest): Promise<ProviderResult> {
      const validated = validateGenerateRequest(request);
      for (const message of validated.messages) {
        for (const content of message.content) {
          if (content.type === "image") assertImageBase64(content.base64, content.mediaType);
        }
      }
      const body: Record<string, unknown> = {
        model: validated.model,
        messages: requestMessages(validated),
        stream: false,
      };
      if (validated.tools?.length) {
        body.tools = validated.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }));
      }
      if (validated.toolChoice !== undefined) body.tool_choice = requestToolChoice(validated.toolChoice);
      if (validated.maxOutputTokens !== undefined) body.max_tokens = validated.maxOutputTokens;
      if (validated.reasoningEffort !== undefined) body.reasoning_effort = validated.reasoningEffort;

      const value = await requestJson(
        config.transport,
        joinProviderUrl(config.baseUrl, "chat/completions"),
        {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: validated.signal,
        },
        limits,
      );
      return parseResponse(value, validated.model);
    },

    async detectCapabilities(model: string): Promise<CapabilityProfile> {
      return detectProviderCapabilities(connector, "openai-compatible", model);
    },
  };
  return connector;
}
