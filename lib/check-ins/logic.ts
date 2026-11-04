import { z } from "zod";

// Sundance / Moondance (ARCHITECTURE §12.3). Pure rules shared by the scheduler, routes and tests: day/night windows,
// adaptive back-off with jitter, the model-free page probe and change detection. Nothing here touches the network.

export const CHECK_IN_KINDS = ["sundance", "moondance"] as const;
export type CheckInKind = (typeof CHECK_IN_KINDS)[number];
export type CheckInStatus = "first" | "unchanged" | "changed" | "failed" | "skipped" | "needs_login";
export const CHECK_IN_VIA = ["fetch", "browser"] as const;
export type CheckInVia = (typeof CHECK_IN_VIA)[number];

export const CHECK_IN_DEFAULTS: Record<CheckInKind, { windowStart: number; windowEnd: number; intervalMinutes: number }> = {
  sundance: { windowStart: 7, windowEnd: 19, intervalMinutes: 15 },
  moondance: { windowStart: 19, windowEnd: 7, intervalMinutes: 60 },
};
export const MAX_CHECK_INS_PER_AGENT = 10;
export const SNAPSHOT_LIMIT = 12_000;
const MAX_INTERVAL = 720;

// Owner-named https page. The probe single-quotes it inside a shell command, so anything beyond plain URL characters
// (quotes, dollar signs, spaces, backslashes, backticks, control characters) is refused rather than escaped.
const SAFE_URL = /^[A-Za-z0-9\-._~:/?#[\]@!&()*+,;=%]+$/;
export function normalizeCheckInUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < 9 || trimmed.length > 2000 || !SAFE_URL.test(trimmed) || trimmed.includes("'")) return null;
  let url: URL;
  try { url = new URL(trimmed); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".")) return null;
  const href = url.href;
  return href.length <= 2000 && SAFE_URL.test(href) && !href.includes("'") ? href : null;
}

export const checkInInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(CHECK_IN_KINDS),
  url: z.string().max(2000).transform((value, ctx) => {
    const url = normalizeCheckInUrl(value);
    if (!url) { ctx.addIssue({ code: "custom", message: "invalid_url" }); return z.NEVER; }
    return url;
  }),
  via: z.enum(CHECK_IN_VIA).optional().default("fetch"),
  goal: z.string().trim().max(2000).optional().transform((value) => value ? value : null),
  urgent: z.boolean().optional().default(false),
  intervalMinutes: z.number().int().min(5).max(MAX_INTERVAL).optional(),
  windowStart: z.number().int().min(0).max(23).optional(),
  windowEnd: z.number().int().min(0).max(23).optional(),
}).strict().transform((value, ctx) => {
  const defaults = CHECK_IN_DEFAULTS[value.kind];
  const windowStart = value.windowStart ?? defaults.windowStart;
  const windowEnd = value.windowEnd ?? defaults.windowEnd;
  if (windowStart === windowEnd) { ctx.addIssue({ code: "custom", message: "invalid_window" }); return z.NEVER; }
  return { ...value, windowStart, windowEnd, intervalMinutes: value.intervalMinutes ?? defaults.intervalMinutes };
});
export type CheckInInput = z.infer<typeof checkInInputSchema>;

export const checkInUpdateSchema = z.object({ active: z.boolean() }).strict();

function localParts(at: Date, timeZone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(at);
  return { hour: Number(parts.find((part) => part.type === "hour")?.value ?? 0) % 24, minute: Number(parts.find((part) => part.type === "minute")?.value ?? 0) };
}

export function inWindow(hour: number, start: number, end: number): boolean {
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export function isInWindow(at: Date, timeZone: string, start: number, end: number): boolean {
  return inWindow(localParts(at, timeZone).hour, start, end);
}

// The first whole local hour `start` after `from`, in five-minute steps so DST shifts and half-hour zones still land.
export function nextWindowStart(from: Date, timeZone: string, start: number): Date {
  const step = 5 * 60_000;
  let at = new Date(Math.ceil(from.getTime() / step) * step);
  for (let i = 0; i < 49 * 12; i++, at = new Date(at.getTime() + step)) {
    const local = localParts(at, timeZone);
    if (local.hour === start && local.minute < 5) return at;
  }
  return new Date(from.getTime() + 24 * 60 * 60_000);
}

// 15 → 30 → 60: four quiet checks double the interval, eight quadruple it. Any change resets the streak.
export function effectiveInterval(baseMinutes: number, quietStreak: number): number {
  const factor = quietStreak >= 8 ? 4 : quietStreak >= 4 ? 2 : 1;
  return Math.min(baseMinutes * factor, MAX_INTERVAL);
}

export function planNextCheck(input: {
  now: Date; timeZone: string; windowStart: number; windowEnd: number; intervalMinutes: number; quietStreak: number; random?: number;
}): Date {
  const random = input.random ?? Math.random();
  const minutes = effectiveInterval(input.intervalMinutes, input.quietStreak) * (0.9 + 0.2 * Math.min(Math.max(random, 0), 1));
  const candidate = new Date(input.now.getTime() + Math.round(minutes * 60_000));
  return isInWindow(candidate, input.timeZone, input.windowStart, input.windowEnd)
    ? candidate
    : nextWindowStart(candidate, input.timeZone, input.windowStart);
}

// Runs as the agent inside its own sandbox: curl goes through the agent's egress relay, so its website allowlist,
// the private-address block and the leak tripwire all apply. python3 strips markup and prints a fingerprint plus a
// bounded text snapshot. A password field means a login wall (EC-LOGIN). The URL was validated by
// normalizeCheckInUrl and contains no quote; the python program contains none either (\x27 stands for one).
const NORMALIZE = [
  "import sys,re,hashlib,html",
  "b=sys.stdin.buffer.read(5000001)",
  "t=b.decode(\"utf-8\",\"replace\")",
  "print(\"EC-LOGIN\") if re.search(r\"(?i)<input[^>]+type\\s*=\\s*[\\\"\\x27]?password\",t) else None",
  "t=re.sub(r\"(?is)<(script|style|noscript|template|svg)[^>]*>.*?</\\1>\",\" \",t)",
  "t=re.sub(r\"(?s)<!--.*?-->\",\" \",t)",
  "t=re.sub(r\"(?s)<[^>]+>\",\"\\n\",t)",
  "t=html.unescape(t)",
  "ls=[re.sub(r\"\\s+\",\" \",l).strip() for l in t.split(\"\\n\")]",
  "x=\"\\n\".join(l for l in ls if l)",
  "print(\"EC-FP \"+hashlib.sha256(x.encode()).hexdigest())",
  "print(x[:" + SNAPSHOT_LIMIT + "])",
].join(";");

export function probeCommand(url: string): string {
  const safe = normalizeCheckInUrl(url);
  if (!safe || safe !== url) throw new Error("invalid_url");
  // No -f: the HTTP status is printed first so 401/403 can be told apart from an unreachable page.
  return `f="$TMPDIR/ec-check-in.$$"; code=$(curl -sSL --max-time 20 --max-filesize 5000000 --max-redirs 5 --proto '=https' --proto-redir '=https' -A 'EclipseCrew-CheckIn' -o "$f" -w '%{http_code}' -- '${safe}') || { rm -f "$f"; exit 7; }; echo "EC-HTTP $code"; python3 -c '${NORMALIZE}' < "$f"; s=$?; rm -f "$f"; exit $s`;
}

export type ProbeResult =
  | { kind: "ok"; fingerprint: string; snapshot: string }
  | { kind: "login" }
  | { kind: "unreachable" };

export function parseProbeOutput(stdout: string): ProbeResult {
  const http = /^EC-HTTP (\d{3})\n/.exec(stdout);
  if (!http) return { kind: "unreachable" };
  const code = Number(http[1]);
  if (code === 401 || code === 403) return { kind: "login" };
  let rest = stdout.slice(http[0].length);
  const login = rest.startsWith("EC-LOGIN\n");
  if (login) rest = rest.slice("EC-LOGIN\n".length);
  if (code < 200 || code > 299) return { kind: "unreachable" };
  if (login) return { kind: "login" };
  const match = /^EC-FP ([0-9a-f]{64})\n?/.exec(rest);
  if (!match) return { kind: "unreachable" };
  return { kind: "ok", fingerprint: match[1], snapshot: rest.slice(match[0].length).slice(0, SNAPSHOT_LIMIT).replace(/\n$/, "") };
}

// Browser mode reads the agent's own Chromium (its cookies, so a login done during takeover counts). The snapshot
// lists the page title and up to 150 visible labelled links, buttons and fields; that text is what gets fingerprinted.
export function browserSnapshotText(page: { title: string; elements: { role: string; name: string }[] }): string {
  return [page.title, ...page.elements.filter((element) => element.name).map((element) => `${element.role}: ${element.name}`)]
    .join("\n").slice(0, SNAPSHOT_LIMIT);
}

// Password fields are never listed by the snapshot, so a login wall is recognised by its address or by a near-empty
// page that is mostly a sign-in control.
const LOGIN_PATH = /(^|[/._-])(log-?in|sign-?in|signon|sso|auth|oauth|session)([/._?#-]|$)/i;
const SIGN_IN_NAME = /^(sign in|log in|login|sign on|continue with .+|next)$/i;
export function looksLikeLogin(expectedUrl: string, page: { href: string; elements: { role: string; name: string }[] }): boolean {
  let href: URL;
  try { href = new URL(page.href); } catch { return false; }
  const expected = new URL(expectedUrl);
  if (LOGIN_PATH.test(href.pathname) && !LOGIN_PATH.test(expected.pathname)) return true;
  const named = page.elements.filter((element) => element.name);
  return named.length <= 15 && named.some((element) => SIGN_IN_NAME.test(element.name.trim()));
}

// Lines added or removed between two snapshots (as multisets). Counts only: page text never reaches a card or a model.
export function changedLines(before: string | null, after: string): { added: number; removed: number } {
  const count = (text: string) => {
    const map = new Map<string, number>();
    for (const line of text.split("\n")) if (line) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const a = count(before ?? "");
  const b = count(after);
  let added = 0, removed = 0;
  for (const [line, n] of b) added += Math.max(0, n - (a.get(line) ?? 0));
  for (const [line, n] of a) removed += Math.max(0, n - (b.get(line) ?? 0));
  return { added, removed };
}

export function kindLabel(kind: CheckInKind): string {
  return kind === "sundance" ? "Sundance" : "Moondance";
}

export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

// The owner's goal is the task; the change itself is described by counts only, never by page text.
export function wakeTask(input: { name: string; url: string; goal: string; added: number; removed: number }): string {
  return `${input.goal}\n\nCheck-in "${input.name}": ${input.url} changed since the last check (${input.added} lines added, ${input.removed} removed). Open the page to see what changed, then do the task above.`;
}
