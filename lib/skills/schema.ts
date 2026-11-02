import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max).refine(
  (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),
  "must not contain control characters",
);
const name = z.string().trim().toLowerCase().min(1).max(80).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const inputName = z.string().trim().toLowerCase().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/);

export const skillInputSchema = z.object({
  name: inputName,
  description: text(300),
  secret: z.boolean(),
}).strict();

export const skillStepSchema = z.object({
  instruction: text(500),
  eventSequence: z.number().int().min(0).max(299),
  postcondition: text(500),
  input: inputName.optional(),
}).strict();

export const skillModelDraftSchema = z.object({
  name,
  description: text(500),
  inputs: z.array(skillInputSchema).max(16),
  steps: z.array(skillStepSchema).min(1).max(32),
}).strict().superRefine((value, context) => {
  const inputNames = new Set(value.inputs.map((input) => input.name));
  if (inputNames.size !== value.inputs.length) context.addIssue({ code: "custom", message: "input names must be unique" });
  const sequences = new Set<number>();
  for (const [index, step] of value.steps.entries()) {
    if (sequences.has(step.eventSequence)) context.addIssue({ code: "custom", path: ["steps", index], message: "event sequences must be unique" });
    sequences.add(step.eventSequence);
    if (step.input && !inputNames.has(step.input)) context.addIssue({ code: "custom", path: ["steps", index, "input"], message: "unknown input" });
  }
});

export type SkillModelDraft = z.infer<typeof skillModelDraftSchema>;

export const skillSourceSchema = z.enum(["video", "steps_screenshots"]);
export type SkillSource = z.infer<typeof skillSourceSchema>;

export const referenceShotSchema = z.object({
  step: z.number().int().min(1).max(32),
  eventSequence: z.number().int().min(0).max(299),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  mime: z.literal("image/png"),
  path: z.string().min(1).max(500).optional(),
}).strict();

export type ReferenceShot = z.infer<typeof referenceShotSchema>;

export const skillStatusSchema = z.enum(["draft", "cleanup_pending", "approved"]);

export const skillViewSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  captureId: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  source: skillSourceSchema,
  status: skillStatusSchema,
  version: z.number().int().positive(),
  body: z.string(),
  referenceShots: z.array(referenceShotSchema),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export type SkillView = z.infer<typeof skillViewSchema>;

export const skillGenerateResponseSchema = z.object({ skill: skillViewSchema }).strict();
