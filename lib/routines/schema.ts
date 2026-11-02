import { z } from "zod";

const display = z.string().trim().min(1).max(200).refine(
  (value) => !/[\u0000-\u001f\u007f]/.test(value),
  "must not contain control characters",
);
const cron = z.string().min(9).max(100).regex(/^[\d*/?,L#\- ]+$/);
const weekday = z.number().int().min(0).max(6);

export const routineScheduleSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("once"),
    runAt: z.string().datetime({ offset: true }),
    display,
  }).strict(),
  z.object({
    kind: z.literal("daily"),
    cron,
    display,
  }).strict(),
  z.object({
    kind: z.literal("weekdays"),
    cron,
    display,
  }).strict(),
  z.object({
    kind: z.literal("weekly"),
    cron,
    display,
    weekdays: z.array(weekday).length(1),
  }).strict(),
  z.object({
    kind: z.literal("custom_weekdays"),
    cron,
    display,
    weekdays: z.array(weekday).min(2).max(7),
  }).strict(),
  z.object({
    kind: z.literal("monthly"),
    cron,
    display,
    day: z.number().int().min(1).max(31),
  }).strict(),
  z.object({
    kind: z.literal("cron"),
    cron,
    display,
  }).strict(),
]);

export type RoutineScheduleSpec = z.infer<typeof routineScheduleSpecSchema>;

export const routineCatchUpSchema = z.enum(["skip", "run_once", "run_all"]);

export const routineRecordSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  sourceMessageId: z.string().uuid(),
  skillId: z.string().uuid().nullable(),
  goal: z.string().min(1).max(2_000),
  steps: z.array(z.string().min(1).max(2_000)).max(32),
  schedule: display,
  scheduleSpec: routineScheduleSpecSchema,
  timezone: z.string().min(1).max(100),
  nextRunAt: z.string().datetime({ offset: true }),
  tools: z.array(z.string().min(1).max(64)).max(32),
  budgetCents: z.number().int().min(1).max(100_000_000),
  catchUp: routineCatchUpSchema,
  active: z.boolean(),
  mode: z.literal("cron"),
  createdAt: z.string().datetime({ offset: true }),
}).strict().refine((record) => record.skillId !== null || record.steps.length > 0, {
  path: ["steps"],
  message: "At least one step is required without a skill.",
});

export type RoutineRecord = z.infer<typeof routineRecordSchema>;

export const routineConfirmResponseSchema = z.object({
  routine: routineRecordSchema.nullable(),
}).strict();

export const routineConfirmInputSchema = z.object({}).strict();
