import "server-only";

import { z } from "zod";

import { normalizeBaseUrl } from "../providers/transport";

export const MAIN_MODEL = "muse-spark-1.3";
export const SAM_MODEL = "sam-3.1";
export const modelRoleSchema = z.enum(["main", "sam"]);
export type ModelRole = z.infer<typeof modelRoleSchema>;

const modelId = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const apiKey = z.string().max(16_384).refine(
  (value) => value === "" || (value === value.trim() && !value.includes("\0")),
  "API keys must not have surrounding whitespace or null bytes.",
);
const baseUrl = z.string().max(2048).refine((value) => {
  try {
    normalizeBaseUrl(value);
    return true;
  } catch {
    return false;
  }
}, "Enter a valid HTTP(S) base URL without credentials, query or fragment.");

export const mainModelSettingsSchema = z.object({
  kind: z.enum(["meta", "openai-compatible"]),
  model: modelId,
  baseUrl: baseUrl.optional(),
  apiKey: apiKey.optional(),
}).strict().superRefine((value, context) => {
  if (value.kind === "meta" && value.baseUrl) {
    context.addIssue({ code: "custom", path: ["baseUrl"], message: "Meta uses a fixed endpoint." });
  }
  if (value.kind === "openai-compatible" && !value.baseUrl) {
    context.addIssue({ code: "custom", path: ["baseUrl"], message: "Base URL is required." });
  }
});

export const samModelSettingsSchema = z.object({
  mode: z.enum(["off", "meta"]),
  useMainKey: z.boolean(),
  apiKey: apiKey.optional(),
}).strict().superRefine((value, context) => {
  const hasKey = Boolean(value.apiKey);
  if (value.mode === "off" && value.useMainKey) {
    context.addIssue({ code: "custom", path: ["useMainKey"], message: "SAM is off." });
  }
  if (value.mode === "off" && hasKey) {
    context.addIssue({ code: "custom", path: ["apiKey"], message: "SAM is off." });
  }
  if (value.useMainKey && hasKey) {
    context.addIssue({ code: "custom", path: ["apiKey"], message: "Same-key mode does not accept a key." });
  }
});

export const testModelSchema = z.object({ role: modelRoleSchema }).strict();

export type MainModelSettingsInput = z.infer<typeof mainModelSettingsSchema>;
export type SamModelSettingsInput = z.infer<typeof samModelSettingsSchema>;
