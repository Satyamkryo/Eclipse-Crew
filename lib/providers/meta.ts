import "server-only";

import { isDeepStrictEqual } from "node:util";
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
  ComputerContinuation,
  GenerateRequest,
  MetaProviderConfig,
  ProviderComputerCallOutput,
  ProviderConnector,
  ProviderModel,
  ProviderOutput,
  ProviderResult,
  ProviderSafetyCheck,
} from "./types";

const BASE_URL = "https://api.meta.ai/v1";
const MAX_IDENTIFIER = 1024 * 1024;

const modelSchema = z.object({
  id: z.string().min(1).max(200),
  context_length: z.number().int().positive().max(100_000_000).optional(),
  context_window: z.number().int().positive().max(100_000_000).optional(),
  max_context_length: z.number().int().positive().max(100_000_000).optional(),
}).passthrough();
const modelListSchema = z.object({ data: z.array(modelSchema).max(1000) }).passthrough();

const tokenCount = z.number().int().nonnegative().max(1_000_000_000);
const usageSchema = z.object({
  input_tokens: tokenCount,
  output_tokens: tokenCount,
  input_tokens_details: z.object({ cached_tokens: tokenCount }).passthrough().optional(),
  output_tokens_details: z.object({ reasoning_tokens: tokenCount }).passthrough().optional(),
}).passthrough();

const safetyCheckSchema = z.object({
  id: z.string().min(1).max(MAX_IDENTIFIER),
  code: z.string().max(MAX_IDENTIFIER).nullable().optional(),
  message: z.string().max(MAX_IDENTIFIER).nullable().optional(),
}).strict();
const safetyChecksSchema = z.array(safetyCheckSchema).max(16);

const reasoningItemSchema = z.object({
  type: z.literal("reasoning"),
  id: z.string().min(1).max(MAX_IDENTIFIER),
  encrypted_content: z.string().max(MAX_IDENTIFIER).nullable().optional(),
  summary: z.array(z.object({
    type: z.literal("summary_text"),
    text: z.string().max(MAX_IDENTIFIER),
  }).strict()).max(64),
  content: z.array(z.object({
    type: z.literal("reasoning_text"),
    text: z.string().max(MAX_IDENTIFIER),
  }).strict().passthrough()).max(64).optional(),
}).passthrough();

const messageItemSchema = z.object({
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(z.object({
    type: z.string().min(1).max(64),
    text: z.string().max(MAX_IDENTIFIER).optional(),
  }).passthrough()).max(64),
}).passthrough();

const functionCallItemSchema = z.object({
  type: z.literal("function_call"),
  call_id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  arguments: z.string().max(MAX_IDENTIFIER),
}).passthrough();

const actionSchema = z.record(z.string(), z.unknown());
const computerCallItemSchema = z.object({
  type: z.literal("computer_call"),
  id: z.string().min(1).max(MAX_IDENTIFIER),
  call_id: z.string().min(1).max(64),
  status: z.literal("completed"),
  actions: z.array(actionSchema).max(16).nullable().optional(),
  action: actionSchema.optional(),
  pending_safety_checks: safetyChecksSchema.optional(),
}).passthrough();

const responseSchema = z.object({
  id: z.string().min(1).max(MAX_IDENTIFIER).optional(),
  model: z.string().min(1).max(200).optional(),
  status: z.enum(["completed", "incomplete"]),
  output: z.array(z.object({ type: z.string().min(1).max(64) }).passthrough()).min(1).max(64),
  incomplete_details: z.object({ reason: z.string().max(128) }).passthrough().optional(),
  usage: usageSchema,
}).passthrough();

function contextFrom(model: z.infer<typeof modelSchema>): number | null {
  return model.context_length ?? model.context_window ?? model.max_context_length ?? null;
}

function messageInput(request: GenerateRequest): Record<string, unknown>[] {
  return request.messages.map((message) => ({
    role: message.role,
    content: message.content.flatMap((content) => {
      if (content.type === "text") {
        return [{
          type: message.role === "assistant" ? "output_text" : "input_text",
          text: taggedText(content.text, content.sourceTag),
        }];
      }
      return [
        { type: "input_text", text: taggedImageLabel(content.sourceTag) },
        {
          type: "input_image",
          image_url: imageDataUrl(content.mediaType, content.base64),
          detail: "original",
        },
      ];
    }),
  }));
}

function toolChoice(value: GenerateRequest["toolChoice"]): unknown {
  if (value === undefined || value === "auto" || value === "required") return value;
  return { type: "function", name: value.name };
}

function buildBody(request: GenerateRequest): Record<string, unknown> & { input: unknown[] } {
  const body: Record<string, unknown> & { input: unknown[] } = {
    model: request.model,
    store: false,
    stream: false,
    input: messageInput(request),
  };
  if (request.instructions !== undefined) body.instructions = taggedText(request.instructions, "user");
  if (request.maxOutputTokens !== undefined) body.max_output_tokens = request.maxOutputTokens;
  if (request.reasoningEffort !== undefined) body.reasoning = { effort: request.reasoningEffort };

  const tools: Record<string, unknown>[] = (request.tools ?? []).map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
  if (request.computerUse) tools.push({ type: "computer" });
  if (tools.length) body.tools = tools;
  if (request.toolChoice !== undefined) body.tool_choice = toolChoice(request.toolChoice);
  return body;
}

function parseArguments(value: string): void {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
  } catch {
    throw new ProviderError("invalid_response");
  }
}

function parseResponse(value: unknown, requestedModel: string): ProviderResult {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) throw new ProviderError("invalid_response");

  const outputs: ProviderOutput[] = [];
  const textParts: string[] = [];
  let pendingSafetyChecks: ProviderSafetyCheck[] = [];
  let computerCalls = 0;

  for (const raw of parsed.data.output) {
    if (raw.type === "message") {
      const message = messageItemSchema.safeParse(raw);
      if (!message.success) throw new ProviderError("invalid_response");
      const text = message.data.content
        .filter((item) => item.type === "output_text" && typeof item.text === "string")
        .map((item) => item.text as string)
        .join("");
      textParts.push(text);
      outputs.push({ type: "message", text });
      continue;
    }

    if (raw.type === "function_call") {
      const call = functionCallItemSchema.safeParse(raw);
      if (!call.success) throw new ProviderError("invalid_response");
      parseArguments(call.data.arguments);
      outputs.push({
        type: "function_call",
        callId: call.data.call_id,
        name: call.data.name,
        arguments: call.data.arguments,
      });
      continue;
    }

    if (raw.type === "computer_call") {
      const call = computerCallItemSchema.safeParse(raw);
      if (!call.success || computerCalls !== 0) throw new ProviderError("invalid_response");
      computerCalls += 1;
      const checks = call.data.pending_safety_checks ?? [];
      if (checks.length > 16) throw new ProviderError("invalid_response");
      pendingSafetyChecks = checks;
      const actions = [
        ...(call.data.actions ?? []),
        ...(call.data.action ? [call.data.action] : []),
      ];
      if (actions.length > 16) throw new ProviderError("invalid_response");
      outputs.push({
        type: "computer_call",
        callId: call.data.call_id,
        actions,
        pendingSafetyChecks: checks,
        replayItems: parsed.data.output as Record<string, unknown>[],
      });
      continue;
    }

    if (raw.type === "reasoning") {
      if (!reasoningItemSchema.safeParse(raw).success) throw new ProviderError("invalid_response");
      continue;
    }

    throw new ProviderError("invalid_response");
  }

  if (!outputs.length) throw new ProviderError("invalid_response");

  const reason = parsed.data.incomplete_details?.reason;
  const incompleteReason = parsed.data.status === "incomplete"
    ? reason === "max_output_tokens" || reason === "content_filter" ? reason : "other"
    : null;
  const status = pendingSafetyChecks.length
    ? "safety_review_required"
    : parsed.data.status === "incomplete" ? "incomplete" : "completed";

  return {
    id: parsed.data.id ?? null,
    model: parsed.data.model ?? requestedModel,
    status,
    incompleteReason,
    outputs,
    text: textParts.join("\n"),
    usage: {
      inputTokens: parsed.data.usage.input_tokens,
      outputTokens: parsed.data.usage.output_tokens,
      cachedInputTokens: parsed.data.usage.input_tokens_details?.cached_tokens ?? 0,
      reasoningTokens: parsed.data.usage.output_tokens_details?.reasoning_tokens ?? 0,
    },
  };
}

function assertContributorReasoning(model: string, effort: GenerateRequest["reasoningEffort"]): void {
  if (model.endsWith("-contributor") && effort === "max") throw new ProviderError("invalid_request");
}

function validateReplay(computer: ProviderComputerCallOutput): void {
  let computerItems = 0;
  for (const item of computer.replayItems) {
    if (item.type === "reasoning") {
      if (!reasoningItemSchema.safeParse(item).success) throw new ProviderError("invalid_continuation");
      continue;
    }
    if (item.type === "computer_call") {
      const call = computerCallItemSchema.safeParse(item);
      const actions = [
        ...(call.success ? call.data.actions ?? [] : []),
        ...(call.success && call.data.action ? [call.data.action] : []),
      ];
      if (!call.success || call.data.call_id !== computer.callId ||
          !isDeepStrictEqual(call.data.pending_safety_checks ?? [], computer.pendingSafetyChecks) ||
          !isDeepStrictEqual(actions, computer.actions)) {
        throw new ProviderError("invalid_continuation");
      }
      computerItems += 1;
      continue;
    }
    if (item.type === "message") {
      if (!messageItemSchema.safeParse(item).success) throw new ProviderError("invalid_continuation");
      continue;
    }
    if (item.type === "function_call") {
      if (!functionCallItemSchema.safeParse(item).success) throw new ProviderError("invalid_continuation");
      continue;
    }
    throw new ProviderError("invalid_continuation");
  }
  if (computerItems !== 1) throw new ProviderError("invalid_continuation");
}

export function createMetaConnector(config: MetaProviderConfig, limits: RuntimeLimits): ProviderConnector {
  const connector: ProviderConnector = {
    kind: "meta",

    async listModels(): Promise<ProviderModel[]> {
      const value = await requestJson(
        config.transport,
        joinProviderUrl(BASE_URL, "models"),
        { method: "GET", headers: { Accept: "application/json" } },
        limits,
      );
      const parsed = modelListSchema.safeParse(value);
      if (!parsed.success) throw new ProviderError("invalid_response");
      return parsed.data.data.map((model) => ({
        id: model.id,
        contextTokens: contextFrom(model),
        inputModalities: null,
      }));
    },

    async generate(request: GenerateRequest): Promise<ProviderResult> {
      const validated = validateGenerateRequest(request);
      assertContributorReasoning(validated.model, validated.reasoningEffort);
      for (const message of validated.messages) {
        for (const content of message.content) {
          if (content.type === "image") assertImageBase64(content.base64, content.mediaType);
        }
      }
      const value = await requestJson(
        config.transport,
        joinProviderUrl(BASE_URL, "responses"),
        {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(buildBody(validated)),
        },
        limits,
      );
      return parseResponse(value, validated.model);
    },

    async detectCapabilities(model: string): Promise<CapabilityProfile> {
      return detectProviderCapabilities(connector, "meta", model);
    },

    async continueComputer(continuation: ComputerContinuation): Promise<ProviderResult> {
      const request = validateGenerateRequest(continuation.request);
      assertContributorReasoning(request.model, request.reasoningEffort);
      const acknowledged = safetyChecksSchema.safeParse(continuation.acknowledgedSafetyChecks);
      if (!acknowledged.success) throw new ProviderError("invalid_continuation");

      const screenshot = z.object({
        mediaType: z.literal("image/png"),
        base64: z.string(),
      }).strict().safeParse(continuation.screenshot);
      if (!screenshot.success) throw new ProviderError("invalid_continuation");
      try {
        assertImageBase64(screenshot.data.base64, "image/png");
      } catch {
        throw new ProviderError("invalid_continuation");
      }

      const computer = continuation.result.outputs.find(
        (output): output is ProviderComputerCallOutput => output.type === "computer_call",
      );
      if (!computer || !isDeepStrictEqual(computer.pendingSafetyChecks, acknowledged.data)) {
        throw new ProviderError("invalid_continuation");
      }
      validateReplay(computer);

      const body = buildBody(request);
      body.input = [
        ...body.input,
        ...computer.replayItems,
        {
          type: "computer_call_output",
          call_id: computer.callId,
          acknowledged_safety_checks: acknowledged.data,
          output: {
            type: "computer_screenshot",
            image_url: imageDataUrl("image/png", screenshot.data.base64),
          },
        },
      ];
      const value = await requestJson(
        config.transport,
        joinProviderUrl(BASE_URL, "responses"),
        {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        limits,
      );
      return parseResponse(value, request.model);
    },
  };
  return connector;
}
