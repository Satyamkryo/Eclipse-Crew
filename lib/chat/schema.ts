import { z } from "zod";
import { ACTION_CLASSES } from "../agent/risk";
import { HEAL_FAILURE_CODES } from "../heal/codes";
import { routineCatchUpSchema, routineScheduleSpecSchema } from "../routines/schema";

export const CHAT_PAGE_SIZE = 50;
const MAX_TEXT = 20_000;
const MAX_CARD_TEXT = 2_000;
const MAX_ITEMS = 32;
const MAX_BUDGET_CENTS = 100_000_000;

const text = z.string().trim().min(1).max(MAX_TEXT).refine(
  (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),
  "contains unsupported control characters",
);
const cardText = z.string().trim().min(1).max(MAX_CARD_TEXT).refine(
  (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),
  "contains unsupported control characters",
);
const singleLine = z.string().trim().min(1).max(120).refine(
  (value) => !/[\u0000-\u001f\u007f]/.test(value),
  "must be a single line without control characters",
);
const token = z.string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._:-]*$/));
const timezone = z.string().trim().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, "is not an IANA timezone");

const messageCardSchema = z.object({
  type: z.literal("message"),
  text,
}).strict();

const clarificationCardSchema = z.object({
  type: z.literal("clarification"),
  question: cardText,
  missingParameters: z.array(singleLine).min(1).max(16)
    .transform((values) => [...new Set(values)])
    .refine((values) => new Set(values.map((value) => value.toLowerCase())).size === values.length,
      "missing parameters must be unique"),
}).strict();

const toolConnectionCardSchema = z.object({
  type: z.literal("tool_connection"),
  tool: token,
  name: singleLine,
  description: cardText,
}).strict();

const routineCardShape = {
  type: z.literal("routine"),
  goal: cardText,
  steps: z.array(cardText).max(MAX_ITEMS),
  schedule: singleLine,
  timezone,
  tools: z.array(token).max(MAX_ITEMS).transform((values) => [...new Set(values)]),
  budgetCents: z.number().int().min(1).max(MAX_BUDGET_CENTS),
  catchUp: routineCatchUpSchema,
  skillId: z.string().uuid().optional(),
};
const hasStepsOrSkill = (value: { steps: string[]; skillId?: string }) => value.steps.length > 0 || value.skillId !== undefined;
// Model output: resolution metadata is code-only and is stripped before this schema is used for agent output.
export const routineCardDraftSchema = z.object(routineCardShape).strict().refine(hasStepsOrSkill, "a routine needs steps or a skill");
const routineCardSchema = z.object({
  ...routineCardShape,
  scheduleSpec: routineScheduleSpecSchema.optional(),
  resolvedNextRunAt: z.string().datetime({ offset: true }).optional(),
}).strict().refine(hasStepsOrSkill, "a routine needs steps or a skill");

const budgetShape = {
  period: z.enum(["daily", "monthly"]),
  spentMicroUsd: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  limitCents: z.number().int().min(1).max(MAX_BUDGET_CENTS),
};
const budgetWarningCardSchema = z.object({ type: z.literal("budget_warning"), ...budgetShape }).strict();
const budgetPausedCardSchema = z.object({ type: z.literal("budget_paused"), ...budgetShape }).strict();

export const FILE_KINDS = ["image", "pdf", "document", "text", "audio", "video", "archive"] as const;
export const MAX_FILE_BYTES = 1024 * 1024 * 1024;
// Shows only a safe name and metadata. The file's contents never enter a card (docs/SECURITY.md section 5).
export const fileCardSchema = z.object({
  type: z.literal("file"),
  direction: z.enum(["inbox", "outbox"]),
  name: z.string().min(1).max(255).refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f-\u009f/\\]/.test(value),
    "must be a plain file name"),
  size: z.number().int().min(0).max(MAX_FILE_BYTES),
  kind: z.enum(FILE_KINDS),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

// TASK-044. Points at one self-heal proposal; the diff itself is fetched from the owner-only proposal route.
const skillUpdateCardSchema = z.object({
  type: z.literal("skill_update"),
  proposalId: z.string().uuid(),
  scriptName: singleLine,
  fromVersion: z.number().int().min(1).max(10_000),
  toVersion: z.number().int().min(2).max(10_001),
  failedStep: z.number().int().min(1).max(20),
  changedSteps: z.number().int().min(0).max(40),
  failureCode: z.enum(HEAL_FAILURE_CODES),
}).strict().refine((value) => value.toVersion === value.fromVersion + 1, "the next version follows the current one");

// TASK-050. Page-derived fields are bounded and control-character free; the card never carries the approval's destination
// URL or any model text. `site` is empty only when the page had no readable host, which also disables Always allow.
const approvalCardSchema = z.object({
  type: z.literal("approval"),
  approvalId: z.string().uuid(),
  actionClass: z.enum(ACTION_CLASSES),
  site: z.string().trim().max(255).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "contains control characters"),
  controlName: singleLine,
}).strict();

export const chatCardSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("teach_paused"), captureId: z.string().uuid(), reason: z.string().regex(/^[a-z_]{1,64}$/) }).strict(),
  messageCardSchema,
  clarificationCardSchema,
  toolConnectionCardSchema,
  routineCardSchema,
  fileCardSchema,
  budgetWarningCardSchema,
  budgetPausedCardSchema,
  skillUpdateCardSchema,
  approvalCardSchema,
]);

export const userMessageInputSchema = z.object({ text }).strict();

export const chatHistoryQuerySchema = z.object({
  before: z.string().uuid().optional(),
  after: z.string().uuid().optional(),
}).strict().refine((query) => !(query.before && query.after), "choose one history cursor");

export const chatRoleSchema = z.enum(["user", "agent", "system"]);
export const chatSourceTagSchema = z.enum(["user", "agent", "tool", "system"]);

export const chatMessageSchema = z.object({
  id: z.string().uuid(),
  role: chatRoleSchema,
  card: chatCardSchema,
  sourceTag: chatSourceTagSchema,
  runId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
}).strict();

export const chatHistoryResponseSchema = z.object({
  messages: z.array(chatMessageSchema),
  hasMore: z.boolean(),
}).strict();

export const outboxRefreshResponseSchema = z.object({
  messages: z.array(chatMessageSchema),
  pending: z.number().int().min(0).optional(),
}).strict();

export const chatMessageResponseSchema = z.object({
  message: chatMessageSchema,
}).strict();

export type ChatCard = z.infer<typeof chatCardSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatHistoryQuery = z.infer<typeof chatHistoryQuerySchema>;
export type ChatRole = z.infer<typeof chatRoleSchema>;
export type ChatSourceTag = z.infer<typeof chatSourceTagSchema>;
