import { CronExpressionParser } from "cron-parser";
import { resolveTimezone } from "../time/clock";
import { routineScheduleSpecSchema, type RoutineScheduleSpec } from "./schema";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const WEEKDAY_INDEX = new Map(WEEKDAYS.map((name, index) => [name.toLowerCase(), index]));
const MAX_SCHEDULE_LENGTH = 200;

export class ScheduleError extends Error {
  constructor(public code: "invalid_schedule" | "schedule_in_past") {
    super(code);
    this.name = "ScheduleError";
  }
}

function invalid(): never {
  throw new ScheduleError("invalid_schedule");
}

function parseClock(value: string): { hour: number; minute: number; display: string } {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(value.trim());
  if (!match) return invalid();
  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return invalid();
    if (hour === 12) hour = 0;
    if (meridiem === "pm") hour += 12;
  }
  if (hour > 23 || minute > 59) return invalid();
  return { hour, minute, display: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

function localParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "long",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: get("weekday"),
  };
}

function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, timezone: string): Date {
  let candidate = new Date(Date.UTC(year, month - 1, day, hour, minute));
  for (let index = 0; index < 4; index++) {
    const parts = localParts(candidate, timezone);
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    candidate = new Date(candidate.getTime() + Date.UTC(year, month - 1, day, hour, minute) - represented);
    if (represented === Date.UTC(year, month - 1, day, hour, minute)) break;
  }
  const check = localParts(candidate, timezone);
  if (check.year !== year || check.month !== month || check.day !== day ||
      check.hour !== hour || check.minute !== minute) return invalid();
  return candidate;
}

function dateParts(year: number, month: number, day: number) {
  const offset = new Date(Date.UTC(year, month - 1, day));
  return { year: offset.getUTCFullYear(), month: offset.getUTCMonth() + 1, day: offset.getUTCDate() };
}

function addDays(year: number, month: number, day: number, amount: number) {
  return dateParts(year, month, day + amount);
}

function weekdayIndex(name: string): number {
  const index = WEEKDAY_INDEX.get(name.toLowerCase());
  if (index === undefined) return invalid();
  return index;
}

function nextWeekday(from: number, target: number): number {
  const delta = (target - from + 7) % 7;
  return delta === 0 ? 7 : delta;
}

function parseOnce(text: string, timezone: string, now: Date): RoutineScheduleSpec {
  const relative = /^(today|tomorrow|yesterday|next\s+([a-z]+))\s+(?:at\s+)?(.+)$/i.exec(text);
  if (relative) {
    const clock = parseClock(relative[3] ?? "");
    const local = localParts(now, timezone);
    let date: { year: number; month: number; day: number };
    if (relative[1]?.toLowerCase() === "tomorrow") date = addDays(local.year, local.month, local.day, 1);
    else if (relative[1]?.toLowerCase() === "today") date = { year: local.year, month: local.month, day: local.day };
    else if (relative[1]?.toLowerCase() === "yesterday") return invalid();
    else {
      const target = weekdayIndex(relative[2] ?? "");
      date = addDays(local.year, local.month, local.day, nextWeekday(weekdayIndex(local.weekday), target));
    }
    const runAt = zonedToUtc(date.year, date.month, date.day, clock.hour, clock.minute, timezone);
    if (runAt.getTime() <= now.getTime()) throw new ScheduleError("schedule_in_past");
    return { kind: "once", runAt: runAt.toISOString(), display: text };
  }

  const absolute = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](.+))$/.exec(text);
  if (absolute) {
    const clock = parseClock(absolute[4] ?? "");
    const year = Number(absolute[1]);
    const month = Number(absolute[2]);
    const day = Number(absolute[3]);
    const normalized = dateParts(year, month, day);
    if (normalized.year !== year || normalized.month !== month || normalized.day !== day) return invalid();
    const runAt = zonedToUtc(year, month, day, clock.hour, clock.minute, timezone);
    if (runAt.getTime() <= now.getTime()) throw new ScheduleError("schedule_in_past");
    return { kind: "once", runAt: runAt.toISOString(), display: text };
  }
  return invalid();
}

function parseRecurring(text: string): RoutineScheduleSpec {
  const cronMatch = /^(?:cron\s*:\s*)?(.+)$/i.exec(text);
  const body = cronMatch?.[1]?.trim() ?? "";
  if (/^[\d*/?,L#\-\s]+$/i.test(body) && body.split(/\s+/).length >= 5 && body.split(/\s+/).length <= 6) {
    if (/[Hh]/.test(body)) return invalid();
    return { kind: "cron", cron: body, display: text };
  }

  let match = /^every\s+day\s+at\s+(.+)$/i.exec(text);
  if (match) {
    const clock = parseClock(match[1] ?? "");
    return { kind: "daily", cron: `${clock.minute} ${clock.hour} * * *`, display: text };
  }
  match = /^every\s+weekday\s+at\s+(.+)$/i.exec(text);
  if (match) {
    const clock = parseClock(match[1] ?? "");
    return { kind: "weekdays", cron: `${clock.minute} ${clock.hour} * * 1-5`, display: text };
  }
  match = /^every\s+month\s+on\s+(?:day\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+at\s+(.+)$/i.exec(text);
  if (match) {
    const day = Number(match[1]);
    if (day < 1 || day > 31) return invalid();
    const clock = parseClock(match[2] ?? "");
    return { kind: "monthly", day, cron: `${clock.minute} ${clock.hour} ${day} * *`, display: text };
  }
  match = /^every\s+(.+?)\s+at\s+(.+)$/i.exec(text);
  if (match) {
    const clock = parseClock(match[2] ?? "");
    const names = (match[1] ?? "").replace(/\band\b/gi, ",").split(",").map((name) => name.trim()).filter(Boolean);
    if (names.length === 0) return invalid();
    const weekdays = names.map(weekdayIndex);
    if (new Set(weekdays).size !== weekdays.length) return invalid();
    const sorted = [...weekdays].sort((a, b) => a - b);
    const cronWeekdays = sorted.map((day) => day === 0 ? 7 : day).join(",");
    return {
      kind: sorted.length === 1 ? "weekly" : "custom_weekdays",
      cron: `${clock.minute} ${clock.hour} * * ${cronWeekdays}`,
      display: text,
      weekdays: sorted,
    };
  }
  return invalid();
}

export function nextRoutineRun(spec: RoutineScheduleSpec, timezone: string, after: Date): Date {
  const parsed = routineScheduleSpecSchema.parse(spec);
  if (parsed.kind === "once") {
    const runAt = new Date(parsed.runAt);
    if (runAt.getTime() <= after.getTime()) throw new ScheduleError("schedule_in_past");
    return runAt;
  }
  try {
    const fields = parsed.cron.trim().split(/\s+/);
    const expression = fields.length === 5 ? `0 ${fields.join(" ")}` : fields.join(" ");
    return CronExpressionParser.parse(expression, {
      currentDate: after,
      tz: timezone,
      strict: true,
    }).next().toDate();
  } catch {
    return invalid();
  }
}

export function previousRoutineRun(spec: RoutineScheduleSpec, timezone: string, before: Date): Date | null {
  const parsed = routineScheduleSpecSchema.parse(spec);
  if (parsed.kind === "once") {
    const runAt = new Date(parsed.runAt);
    return runAt.getTime() < before.getTime() ? runAt : null;
  }
  try {
    const fields = parsed.cron.trim().split(/\s+/);
    const expression = fields.length === 5 ? `0 ${fields.join(" ")}` : fields.join(" ");
    return CronExpressionParser.parse(expression, {
      currentDate: before,
      tz: timezone,
      strict: true,
    }).prev().toDate();
  } catch {
    return null;
  }
}

export function parseRoutineSchedule(
  value: string,
  options: { timezone: string; now: Date },
): RoutineScheduleSpec & { nextRun: Date } {
  if (typeof value !== "string") return invalid();
  const text = value.trim();
  if (!text || text.length > MAX_SCHEDULE_LENGTH || /[\u0000-\u001f\u007f]/.test(text)) return invalid();
  if (!resolveTimezone(options.timezone)) return invalid();
  const spec = /^(?:today|tomorrow|yesterday|next\s+[a-z]+|\d{4}-\d{2}-\d{2})/i.test(text)
    ? parseOnce(text, options.timezone, options.now)
    : parseRecurring(text);
  return { ...routineScheduleSpecSchema.parse(spec), nextRun: nextRoutineRun(spec, options.timezone, options.now) };
}

export function displayNextRun(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}
