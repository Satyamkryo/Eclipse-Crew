import "server-only";

import { and, asc, eq } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { agents, routines } from "../../db/schema";
import { routineScheduleSpecSchema } from "../routines/schema";
import { nextRoutineRun } from "../routines/schedule";
import { resolveTimezone } from "../time/clock";
import type { PausedRoutine, RoutineCatchUp, UpcomingRoutine, UpcomingView } from "./view";

type Database = Awaited<ReturnType<typeof getDatabase>>;

const MAX_PER_ROUTINE = 50;
const MAX_TOTAL = 200;

type RoutineRow = {
  id: string; agentId: string; agentName: string | null; goal: string; schedule: string;
  scheduleSpec: unknown; timezone: string; nextRunAt: Date; budgetCents: number; catchUp: string; active: boolean;
};

async function readRoutines(database: Database, ownerId: string, active: boolean, agentId: string | undefined): Promise<RoutineRow[]> {
  const conditions = [eq(routines.ownerId, ownerId), eq(routines.active, active)];
  if (agentId) conditions.push(eq(routines.agentId, agentId));
  return database.select({
    id: routines.id,
    agentId: routines.agentId,
    agentName: agents.name,
    goal: routines.goal,
    schedule: routines.schedule,
    scheduleSpec: routines.scheduleSpec,
    timezone: routines.timezone,
    nextRunAt: routines.nextRunAt,
    budgetCents: routines.budgetCents,
    catchUp: routines.catchUp,
    active: routines.active,
  }).from(routines)
    .leftJoin(agents, and(eq(agents.id, routines.agentId), eq(agents.ownerId, ownerId)))
    .where(and(...conditions))
    .orderBy(asc(routines.nextRunAt))
    .limit(200) as Promise<RoutineRow[]>;
}

const catchUpOf = (value: string): RoutineCatchUp =>
  value === "run_all" ? "run_all" : value === "run_once" ? "run_once" : "skip";

function localDateKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function localDateLabel(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "long", month: "long", day: "numeric", year: "numeric",
  }).format(date).replace(",", " ·");
}

export async function listUpcoming(
  database: Database, ownerId: string, options: { days: 1 | 7 | 30; agentId?: string; timezone: string; now?: Date },
): Promise<UpcomingView> {
  const now = options.now ?? new Date();
  const timezone = resolveTimezone(options.timezone) ?? "UTC";
  const horizon = new Date(now.getTime() + options.days * 24 * 60 * 60_000);
  const [activeRows, pausedRows] = await Promise.all([
    readRoutines(database, ownerId, true, options.agentId),
    readRoutines(database, ownerId, false, options.agentId),
  ]);

  const runs: UpcomingRoutine[] = [];
  let truncated = false;
  for (const row of activeRows) {
    const spec = routineScheduleSpecSchema.safeParse(row.scheduleSpec);
    if (!spec.success) continue;
    const routineTimezone = resolveTimezone(row.timezone) ?? "UTC";
    // The stored next run is the first occurrence. Scheduling starts after it, not after "now" (which would skip it).
    let after = now;
    if (row.nextRunAt.getTime() > now.getTime()) {
      after = row.nextRunAt;
      if (row.nextRunAt.getTime() <= horizon.getTime()) {
        runs.push({
          routineId: row.id, label: row.goal, agentId: row.agentId, agentName: row.agentName ?? "Unknown agent",
          startAt: row.nextRunAt.toISOString(), timezone: routineTimezone, schedule: row.schedule,
          budgetCents: row.budgetCents, catchUp: catchUpOf(row.catchUp),
        });
      }
    }
    for (let count = 0; count < MAX_PER_ROUTINE; count++) {
      if (runs.length >= MAX_TOTAL) { truncated = true; break; }
      let next: Date;
      try { next = nextRoutineRun(spec.data, routineTimezone, after); } catch { break; }
      if (next.getTime() > horizon.getTime()) break;
      runs.push({
        routineId: row.id,
        label: row.goal,
        agentId: row.agentId,
        agentName: row.agentName ?? "Unknown agent",
        startAt: next.toISOString(),
        timezone: routineTimezone,
        schedule: row.schedule,
        budgetCents: row.budgetCents,
        catchUp: catchUpOf(row.catchUp),
      });
      after = next;
    }
    if (runs.length >= MAX_TOTAL) { truncated = true; break; }
  }

  runs.sort((left, right) => left.startAt.localeCompare(right.startAt));
  const days: UpcomingView["days"] = [];
  for (const run of runs) {
    const start = new Date(run.startAt);
    const date = localDateKey(start, timezone);
    const existing = days.find((day) => day.date === date);
    if (existing) existing.runs.push(run);
    else days.push({ date, label: localDateLabel(start, timezone), runs: [run] });
  }

  const paused: PausedRoutine[] = pausedRows.map((row) => ({
    routineId: row.id,
    label: row.goal,
    agentId: row.agentId,
    agentName: row.agentName ?? "Unknown agent",
    nextRunAt: row.nextRunAt.toISOString(),
    timezone: resolveTimezone(row.timezone) ?? "UTC",
    schedule: row.schedule,
    budgetCents: row.budgetCents,
    catchUp: catchUpOf(row.catchUp),
  }));

  return { timezone, days, paused, truncated };
}
