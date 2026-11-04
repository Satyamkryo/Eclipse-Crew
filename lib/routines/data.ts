import "server-only";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { getDatabase } from "../../db/client";
import { chatSessions, messages, routines, skills } from "../../db/schema";
import { chatCardSchema, routineCardDraftSchema, type ChatCard } from "../chat/schema";
import { nextRoutineRun, parseRoutineSchedule } from "./schedule";
import { routineScheduleSpecSchema, type RoutineRecord } from "./schema";

type Database = Awaited<ReturnType<typeof getDatabase>>;

export class RoutineError extends Error {
  constructor(public code: "routine_not_found" | "invalid_routine" | "skill_not_available" | "once_expired") {
    super(code);
    this.name = "RoutineError";
  }
}

export function prepareRoutineCard(value: unknown, options: { now: Date }): Extract<ChatCard, { type: "routine" }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RoutineError("invalid_routine");
  const { resolvedNextRunAt: _resolved, scheduleSpec: _spec, ...input } = value as Record<string, unknown>;
  const parsed = routineCardDraftSchema.safeParse(input);
  if (!parsed.success) throw new RoutineError("invalid_routine");
  try {
    const schedule = parseRoutineSchedule(parsed.data.schedule, { timezone: parsed.data.timezone, now: options.now });
    const { nextRun, ...scheduleSpec } = schedule;
    return chatCardSchema.parse({
      ...parsed.data,
      scheduleSpec,
      resolvedNextRunAt: nextRun.toISOString(),
    }) as Extract<ChatCard, { type: "routine" }>;
  } catch {
    throw new RoutineError("invalid_routine");
  }
}

function serializeRoutine(row: typeof routines.$inferSelect): RoutineRecord {
  return {
    id: row.id,
    agentId: row.agentId,
    sourceMessageId: row.sourceMessageId,
    skillId: row.skillId,
    goal: row.goal,
    steps: row.steps as string[],
    schedule: row.schedule,
    scheduleSpec: row.scheduleSpec as RoutineRecord["scheduleSpec"],
    timezone: row.timezone,
    nextRunAt: row.nextRunAt.toISOString(),
    tools: row.tools,
    budgetCents: row.budgetCents,
    catchUp: row.catchUp as RoutineRecord["catchUp"],
    active: row.active,
    mode: "cron",
    createdAt: row.createdAt.toISOString(),
  };
}

// TASK-042. Pause leaves the stored next run untouched; resume recomputes it from now, because paused time is not
// downtime and must not trigger the catch-up policy. A one-off whose moment has passed cannot be resumed.
export async function setRoutineActive(
  database: Pick<Database, "select" | "update">, ownerId: string, routineId: string, active: boolean, now = new Date(),
): Promise<RoutineRecord> {
  const found = await database.select().from(routines)
    .where(and(eq(routines.ownerId, ownerId), eq(routines.id, routineId))).limit(1);
  if (!found[0]) throw new RoutineError("routine_not_found");
  const row = found[0];
  let nextRunAt = row.nextRunAt;
  if (active) {
    const spec = routineScheduleSpecSchema.safeParse(row.scheduleSpec);
    if (!spec.success) throw new RoutineError("invalid_routine");
    if (spec.data.kind === "once") {
      const runAt = new Date(spec.data.runAt);
      if (!Number.isFinite(runAt.getTime()) || runAt.getTime() <= now.getTime()) throw new RoutineError("once_expired");
      nextRunAt = runAt;
    } else {
      try { nextRunAt = nextRoutineRun(spec.data, row.timezone, now); } catch { throw new RoutineError("invalid_routine"); }
    }
  }
  const updated = await database.update(routines).set({ active, nextRunAt, updatedAt: now })
    .where(and(eq(routines.ownerId, ownerId), eq(routines.id, routineId))).returning();
  if (!updated[0]) throw new RoutineError("routine_not_found");
  return serializeRoutine(updated[0]);
}

// Owner-scoped routine delete. Runs are append-only proof and stay; only the schedule row is removed.
export async function deleteRoutine(
  database: Pick<Database, "select" | "delete">, ownerId: string, routineId: string,
): Promise<{ agentId: string }> {
  const found = await database.select({ agentId: routines.agentId }).from(routines)
    .where(and(eq(routines.ownerId, ownerId), eq(routines.id, routineId))).limit(1);
  if (!found[0]) throw new RoutineError("routine_not_found");
  await database.delete(routines)
    .where(and(eq(routines.ownerId, ownerId), eq(routines.id, routineId)));
  return { agentId: found[0].agentId };
}

async function ownedRoutineCard(database: Pick<Database, "select">, ownerId: string, agentId: string, messageId: string) {
  const rows = await database.select({ content: messages.content }).from(messages)
    .innerJoin(chatSessions, eq(messages.sessionId, chatSessions.id))
    .where(and(
      eq(messages.ownerId, ownerId),
      eq(messages.id, messageId),
      eq(chatSessions.ownerId, ownerId),
      eq(chatSessions.agentId, agentId),
    )).limit(1);
  return rows[0]?.content;
}

export async function readRoutineForMessage(
  database: Pick<Database, "select">, ownerId: string, agentId: string, messageId: string,
): Promise<RoutineRecord | null> {
  const found = await database.select().from(routines)
    .where(and(eq(routines.ownerId, ownerId), eq(routines.agentId, agentId), eq(routines.sourceMessageId, messageId)))
    .limit(1);
  if (found[0]) return serializeRoutine(found[0]);
  const card = await ownedRoutineCard(database, ownerId, agentId, messageId);
  if (card === undefined) throw new RoutineError("routine_not_found");
  const parsed = chatCardSchema.safeParse(card);
  if (!parsed.success || parsed.data.type !== "routine") throw new RoutineError("routine_not_found");
  return null;
}

export async function confirmRoutine(
  database: Pick<Database, "select" | "insert">,
  ownerId: string,
  agentId: string,
  messageId: string,
  options: { now?: Date } = {},
): Promise<RoutineRecord> {
  const existing = await readRoutineForMessage(database, ownerId, agentId, messageId);
  if (existing) return existing;

  const cardValue = await ownedRoutineCard(database, ownerId, agentId, messageId);
  const parsed = chatCardSchema.safeParse(cardValue);
  if (!parsed.success || parsed.data.type !== "routine") throw new RoutineError("routine_not_found");
  const card = parsed.data;
  const now = options.now ?? new Date();
  let scheduleSpec = card.scheduleSpec;
  if (!scheduleSpec) {
    try {
      const resolved = parseRoutineSchedule(card.schedule, { timezone: card.timezone, now });
      const { nextRun: _nextRun, ...spec } = resolved;
      scheduleSpec = spec;
    } catch {
      throw new RoutineError("invalid_routine");
    }
  }
  let nextRunAt: Date;
  try {
    const resolved = card.resolvedNextRunAt ? new Date(card.resolvedNextRunAt) : null;
    nextRunAt = resolved && resolved.getTime() > now.getTime()
      ? resolved
      : scheduleSpec.kind === "once"
        ? new Date(scheduleSpec.runAt)
        : nextRoutineRun(scheduleSpec, card.timezone, now);
  } catch {
    throw new RoutineError("invalid_routine");
  }
  if (!Number.isFinite(nextRunAt.getTime()) || nextRunAt.getTime() <= now.getTime()) throw new RoutineError("invalid_routine");
  if (card.skillId) {
    const approved = await database.select({ id: skills.id }).from(skills).where(and(
      eq(skills.ownerId, ownerId), eq(skills.agentId, agentId), eq(skills.id, card.skillId), eq(skills.status, "approved"),
    )).limit(1);
    if (!approved[0]) throw new RoutineError("skill_not_available");
  }
  const inserted = await database.insert(routines).values({
    id: randomUUID(),
    ownerId,
    agentId,
    sourceMessageId: messageId,
    skillId: card.skillId ?? null,
    goal: card.goal,
    steps: card.steps,
    schedule: card.schedule,
    scheduleSpec,
    timezone: card.timezone,
    nextRunAt,
    tools: card.tools,
    budgetCents: card.budgetCents,
    catchUp: card.catchUp,
    active: true,
    mode: "cron",
  }).onConflictDoNothing({ target: routines.sourceMessageId }).returning();
  if (inserted[0]) return serializeRoutine(inserted[0]);
  const raced = await readRoutineForMessage(database, ownerId, agentId, messageId);
  if (!raced) throw new RoutineError("routine_not_found");
  return raced;
}
