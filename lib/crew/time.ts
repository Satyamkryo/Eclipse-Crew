// TASK-058. Calendar arithmetic in code, never in a model. All functions take an IANA zone and return UTC instants.

const TIME_PATTERN = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

export function parseLocalTime(value: unknown): { hour: number; minute: number } | null {
  if (typeof value !== "string") return null;
  const match = TIME_PATTERN.exec(value);
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
}

export function validTimezone(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value;
  } catch {
    return null;
  }
}

function localParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

// The UTC instant that shows as the requested wall clock in `timezone`. A wall time skipped by a DST jump has no instants
// and returns null; callers move to the next day instead of inventing one.
export function localDateTimeToUtc(
  year: number, month: number, day: number, hour: number, minute: number, timezone: string,
): Date | null {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = localParts(new Date(candidate), timezone);
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    if (represented === target) return new Date(candidate);
    candidate += target - represented;
  }
  const check = localParts(new Date(candidate), timezone);
  return check.year === year && check.month === month && check.day === day && check.hour === hour && check.minute === minute
    ? new Date(candidate)
    : null;
}

function shiftDay(year: number, month: number, day: number, amount: number) {
  const shifted = new Date(Date.UTC(year, month - 1, day + amount));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

// The most recent occurrence of a local wall-clock time at or before `now`. Used for run-once catch-up: missed days are
// not replayed, only the latest occurrence is considered.
export function mostRecentLocalTime(now: Date, timezone: string, localTime: { hour: number; minute: number }): Date | null {
  const today = localParts(now, timezone);
  for (let back = 0; back <= 2; back++) {
    const date = shiftDay(today.year, today.month, today.day, -back);
    const occurrence = localDateTimeToUtc(date.year, date.month, date.day, localTime.hour, localTime.minute, timezone);
    if (occurrence && occurrence.getTime() <= now.getTime()) return occurrence;
  }
  return null;
}

// The next occurrence after `after`, used to decide whether an edit is prospective.
export function nextLocalTime(after: Date, timezone: string, localTime: { hour: number; minute: number }): Date | null {
  const today = localParts(after, timezone);
  for (let forward = 0; forward <= 2; forward++) {
    const date = shiftDay(today.year, today.month, today.day, forward);
    const occurrence = localDateTimeToUtc(date.year, date.month, date.day, localTime.hour, localTime.minute, timezone);
    if (occurrence && occurrence.getTime() > after.getTime()) return occurrence;
  }
  return null;
}

// The owner's local day containing `now`: [local midnight, next local midnight). Used for today's spend with UTC queries.
export function localDayBounds(now: Date, timezone: string): { start: Date; end: Date } {
  const today = localParts(now, timezone);
  const start = localDateTimeToUtc(today.year, today.month, today.day, 0, 0, timezone);
  const tomorrow = shiftDay(today.year, today.month, today.day, 1);
  const end = localDateTimeToUtc(tomorrow.year, tomorrow.month, tomorrow.day, 0, 0, timezone);
  if (start && end) return { start, end };
  const utcStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start: utcStart, end: new Date(utcStart.getTime() + 24 * 60 * 60_000) };
}

export function reportWindow(scheduledAt: Date): { windowStart: Date; windowEnd: Date } {
  return { windowStart: new Date(scheduledAt.getTime() - 24 * 60 * 60_000), windowEnd: scheduledAt };
}
