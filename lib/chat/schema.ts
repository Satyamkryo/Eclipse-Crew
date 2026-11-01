import { z } from "zod";

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

const routineCardSchema = z.object({
  type: z.literal("routine"),
  goal: cardText,
  steps: z.array(cardText).min(1).max(MAX_ITEMS),
  schedule: singleLine,
  timezone,
  tools: z.array(token).max(MAX_ITEMS).transform((values) => [...new Set(values)]),
  budgetCents: z.number().int().min(1).max(MAX_BUDGET_CENTS),
  catchUp: z.enum(["skip", "run_once"]),
}).strict();

export const chatCardSchema = z.discriminatedUnion("type", [
  messageCardSchema,
  clarificationCardSchema,
  toolConnectionCardSchema,
  routineCardSchema,
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

export const chatMessageResponseSchema = z.object({
  message: chatMessageSchema,
}).strict();

export type ChatCard = z.infer<typeof chatCardSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatHistoryQuery = z.infer<typeof chatHistoryQuerySchema>;
export type ChatRole = z.infer<typeof chatRoleSchema>;
export type ChatSourceTag = z.infer<typeof chatSourceTagSchema>;
