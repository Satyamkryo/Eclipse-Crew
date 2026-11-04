import assert from "node:assert/strict";
import test from "node:test";

const unwrap = (m) => m.default ?? m;
const {
  inWindow, isInWindow, nextWindowStart, effectiveInterval, planNextCheck, normalizeCheckInUrl, probeCommand,
  parseProbeOutput, changedLines, checkInInputSchema, wakeTask, CHECK_IN_DEFAULTS, looksLikeLogin, browserSnapshotText,
} = unwrap(await import("../lib/check-ins/logic.ts"));

test("day and night windows, including the overnight wrap", () => {
  assert.equal(inWindow(7, 7, 19), true); assert.equal(inWindow(18, 7, 19), true); assert.equal(inWindow(19, 7, 19), false);
  assert.equal(inWindow(23, 19, 7), true); assert.equal(inWindow(3, 19, 7), true); assert.equal(inWindow(7, 19, 7), false); assert.equal(inWindow(12, 19, 7), false);
  assert.deepEqual(CHECK_IN_DEFAULTS.sundance, { windowStart: 7, windowEnd: 19, intervalMinutes: 15 });
  assert.deepEqual(CHECK_IN_DEFAULTS.moondance, { windowStart: 19, windowEnd: 7, intervalMinutes: 60 });
  // 10:00 UTC is 15:30 in Kolkata: Sundance hours, not Moondance.
  const at = new Date("2026-11-04T10:00:00Z");
  assert.equal(isInWindow(at, "Asia/Kolkata", 7, 19), true);
  assert.equal(isInWindow(at, "Asia/Kolkata", 19, 7), false);
});

test("adaptive back-off: 15 → 30 → 60 when quiet, capped at 12 h", () => {
  assert.equal(effectiveInterval(15, 0), 15); assert.equal(effectiveInterval(15, 3), 15);
  assert.equal(effectiveInterval(15, 4), 30); assert.equal(effectiveInterval(15, 8), 60); assert.equal(effectiveInterval(15, 500), 60);
  assert.equal(effectiveInterval(240, 8), 720);
});

test("the next check has ±10% jitter and never lands outside the window", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  const base = { now, timeZone: "UTC", windowStart: 7, windowEnd: 19, intervalMinutes: 15, quietStreak: 0 };
  assert.equal(planNextCheck({ ...base, random: 0 }).getTime() - now.getTime(), 13.5 * 60_000);
  assert.equal(planNextCheck({ ...base, random: 1 }).getTime() - now.getTime(), 16.5 * 60_000);
  assert.equal(planNextCheck({ ...base, random: 0.5, quietStreak: 4 }).getTime() - now.getTime(), 30 * 60_000);
  // 18:55 + 15 min is after 19:00, so Sundance sleeps until 07:00 the next morning.
  const late = planNextCheck({ ...base, now: new Date("2026-11-04T18:55:00Z"), random: 0.5 });
  assert.equal(late.toISOString(), "2026-11-05T07:00:00.000Z");
  // Moondance at 06:50 sleeps until 19:00 the same day.
  const dawn = planNextCheck({ ...base, now: new Date("2026-11-04T06:50:00Z"), windowStart: 19, windowEnd: 7, random: 0.5 });
  assert.equal(dawn.toISOString(), "2026-11-04T19:00:00.000Z");
  // Half-hour zones still land on the local hour: 07:00 in Kolkata is 01:30 UTC.
  assert.equal(nextWindowStart(new Date("2026-11-04T20:00:00Z"), "Asia/Kolkata", 7).toISOString(), "2026-11-05T01:30:00.000Z");
});

test("only plain https URLs are accepted; shell metacharacters are refused, not escaped", () => {
  assert.equal(normalizeCheckInUrl("https://vendor.example.com/invoices?month=10"), "https://vendor.example.com/invoices?month=10");
  for (const bad of [
    "http://vendor.example.com/", "file:///etc/passwd", "https://user:pw@example.com/", "https://localhost/",
    "https://example.com/'; rm -rf ~; '", "https://example.com/$(id)", "https://example.com/`id`", "https://example.com/a b",
    "https://example.com/\\x", "https://example.com/a\nb", "https://example.com/$x", "javascript:alert(1)", "https://", "x".repeat(2001),
  ]) assert.equal(normalizeCheckInUrl(bad), null, bad);
  assert.throws(() => probeCommand("https://example.com/'; id; '"));
  const command = probeCommand("https://example.com/status");
  assert.match(command, /--proto '=https' --proto-redir '=https'/);
  assert.match(command, /-w '%\{http_code\}' -- 'https:\/\/example\.com\/status'\)/);
  // The python program sits inside single quotes, so it must not contain one.
  const start = command.indexOf("python3 -c '") + 12;
  const program = command.slice(start, command.indexOf("' < \"$f\"", start));
  assert.ok(program.length > 100);
  assert.equal(program.includes("'"), false);
  assert.ok(command.length < 4000, "fits the shell.run limit");
});

test("probe output parsing fails closed and recognises a login wall", () => {
  const fp = "a".repeat(64);
  assert.deepEqual(parseProbeOutput(`EC-HTTP 200\nEC-FP ${fp}\nline one\nline two\n`), { kind: "ok", fingerprint: fp, snapshot: "line one\nline two" });
  assert.deepEqual(parseProbeOutput(`EC-HTTP 200\nEC-LOGIN\nEC-FP ${fp}\nSign in\n`), { kind: "login" });
  assert.deepEqual(parseProbeOutput(`EC-HTTP 401\nEC-FP ${fp}\n`), { kind: "login" });
  assert.deepEqual(parseProbeOutput(`EC-HTTP 403\nEC-FP ${fp}\n`), { kind: "login" });
  assert.deepEqual(parseProbeOutput(`EC-HTTP 404\nEC-FP ${fp}\n`), { kind: "unreachable" });
  assert.deepEqual(parseProbeOutput(`EC-HTTP 500\nEC-LOGIN\nEC-FP ${fp}\n`), { kind: "unreachable" });
  assert.deepEqual(parseProbeOutput("curl: (6) Could not resolve host"), { kind: "unreachable" });
  assert.deepEqual(parseProbeOutput(`EC-HTTP 200\nEC-FP ${"z".repeat(64)}\n`), { kind: "unreachable" });
  assert.deepEqual(parseProbeOutput(`EC-FP ${fp}\n`), { kind: "unreachable" });
});

test("browser mode: login walls by address or a near-empty sign-in page; text is title + labelled controls", () => {
  const rows = [{ role: "link", name: "Invoice 1042" }, { role: "link", name: "Invoice 1043" }, { role: "button", name: "Download" }];
  assert.equal(looksLikeLogin("https://portal.example.com/invoices", { href: "https://portal.example.com/invoices", elements: rows }), false);
  assert.equal(looksLikeLogin("https://portal.example.com/invoices", { href: "https://portal.example.com/login?next=/invoices", elements: [] }), true);
  assert.equal(looksLikeLogin("https://portal.example.com/invoices", { href: "https://accounts.example.com/signin/v2", elements: [] }), true);
  assert.equal(looksLikeLogin("https://portal.example.com/invoices", { href: "https://portal.example.com/invoices", elements: [{ role: "textbox", name: "Email" }, { role: "button", name: "Sign in" }] }), true);
  // A full page that merely has a "Sign in" link in its header is not a wall; nor is a watched page that is itself /login.
  const busy = Array.from({ length: 20 }, (_, i) => ({ role: "link", name: `Item ${i}` })).concat([{ role: "link", name: "Sign in" }]);
  assert.equal(looksLikeLogin("https://news.example.com/", { href: "https://news.example.com/", elements: busy }), false);
  assert.equal(looksLikeLogin("https://status.example.com/login-status", { href: "https://status.example.com/login-status", elements: rows }), false);
  assert.equal(browserSnapshotText({ title: "Invoices", elements: [...rows, { role: "button", name: "" }] }), "Invoices\nlink: Invoice 1042\nlink: Invoice 1043\nbutton: Download");
});

test("changed lines are counted as multisets, never returned as text", () => {
  assert.deepEqual(changedLines("a\nb\nc", "a\nb\nc"), { added: 0, removed: 0 });
  assert.deepEqual(changedLines("a\nb", "a\nb\nInvoice 1043"), { added: 1, removed: 0 });
  assert.deepEqual(changedLines("a\nold\nold", "a\nnew"), { added: 1, removed: 2 });
  assert.deepEqual(changedLines(null, "a\nb"), { added: 2, removed: 0 });
});

test("input schema fills day/night defaults and rejects bad windows", () => {
  const day = checkInInputSchema.parse({ name: " Invoices ", kind: "sundance", url: "https://vendor.example.com/" });
  assert.deepEqual(day, { name: "Invoices", kind: "sundance", url: "https://vendor.example.com/", via: "fetch", goal: null, urgent: false, intervalMinutes: 15, windowStart: 7, windowEnd: 19 });
  const night = checkInInputSchema.parse({ name: "Status", kind: "moondance", url: "https://status.example.com/", goal: "Summarise it", urgent: true });
  assert.equal(night.windowStart, 19); assert.equal(night.windowEnd, 7); assert.equal(night.intervalMinutes, 60); assert.equal(night.goal, "Summarise it");
  assert.equal(checkInInputSchema.safeParse({ name: "x", kind: "sundance", url: "https://a.example/", windowStart: 9, windowEnd: 9 }).success, false);
  assert.equal(checkInInputSchema.safeParse({ name: "x", kind: "sundance", url: "https://a.example/", intervalMinutes: 1 }).success, false);
  assert.equal(checkInInputSchema.safeParse({ name: "x", kind: "noon", url: "https://a.example/" }).success, false);
  assert.equal(checkInInputSchema.safeParse({ name: "x", kind: "sundance", url: "https://a.example/", extra: 1 }).success, false);
});

test("the wake task is the owner's goal plus counts; no page text", () => {
  const task = wakeTask({ name: "Invoices", url: "https://vendor.example.com/", goal: "Download new invoices.", added: 2, removed: 1 });
  assert.match(task, /^Download new invoices\./);
  assert.match(task, /2 lines added, 1 removed/);
});
