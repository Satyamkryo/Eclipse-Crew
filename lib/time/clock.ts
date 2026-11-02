import "server-only";

// The clock is produced by code, never by the model (AGENTS.md 13, ADR-017).
// Every agent model call ends its `instructions` with withClock(...), after the stable text, so caching of that text survives.

const FALLBACK_TIMEZONE = "Etc/UTC";
const SEPARATOR = " \u00b7 ";
// IANA-looking names only: `UTC` or `Area/City` (up to three parts). The runtime must also know the name.
const NAME = /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){1,2})$/;

export function resolveTimezone(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64 || !NAME.test(value)) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return value; } catch { return null; }
}

interface LocalTime { iso: string; weekday: string }

// "2026-10-28T04:45:00+05:30" and the weekday, for the given zone. Seconds are optional.
function localTime(now: Date, timezone: string, seconds: boolean): LocalTime {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23", weekday: "long", timeZoneName: "longOffset",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const offset = get("timeZoneName").replace("GMT", "") || "+00:00";
  const clock = `${get("hour")}:${get("minute")}${seconds ? `:${get("second")}` : ":00"}`;
  return { iso: `${get("year")}-${get("month")}-${get("day")}T${clock}${offset}`, weekday: get("weekday") };
}

function utcText(now: Date, seconds: boolean): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 16)}${seconds ? iso.slice(16, 19) : ":00"}Z`;
}

// Rounded down to the minute so the text after the stable prefix changes once a minute.
export function clockBlock(now: Date, ownerTimezone: string): string {
  const timezone = resolveTimezone(ownerTimezone) ?? FALLBACK_TIMEZONE;
  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const local = localTime(minute, timezone, false);
  return `Now: ${local.iso} (${local.weekday})${SEPARATOR}User timezone: ${timezone}${SEPARATOR}UTC: ${utcText(minute, false)}`;
}

export function withClock(instructions: string, now: Date, ownerTimezone: string): string {
  return `${instructions}\n\n${clockBlock(now, ownerTimezone)}`;
}

export type TimeAnswer = { ok: true; text: string } | { ok: false };

// Answer for the get_time action. Only a validated zone name is ever written into the text.
export function getTime(now: Date, requested: string | undefined, ownerTimezone: string): TimeAnswer {
  const timezone = requested === undefined ? (resolveTimezone(ownerTimezone) ?? FALLBACK_TIMEZONE) : resolveTimezone(requested);
  if (!timezone) return { ok: false };
  const local = localTime(now, timezone, true);
  return { ok: true, text: `Time in ${timezone}: ${local.iso} (${local.weekday}); UTC ${utcText(now, true)}` };
}
