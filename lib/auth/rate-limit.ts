import "server-only";
// One owner and one bounded bucket: forwarding headers cannot select or evade it.
let attempts: { count: number; firstAt: number; lockedUntil?: number } | undefined;
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 5 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
export function checkRateLimit(): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  if (attempts?.lockedUntil && now < attempts.lockedUntil)
    return { allowed: false, retryAfter: Math.ceil((attempts.lockedUntil - now) / 1000) };
  if (attempts && (attempts.lockedUntil || now - attempts.firstAt >= WINDOW_MS)) attempts = undefined;
  attempts ??= { count: 0, firstAt: now };
  attempts.count++;
  if (attempts.count >= MAX_ATTEMPTS) attempts.lockedUntil = now + LOCKOUT_MS;
  return { allowed: true };
}
export function recordFailure(): void {
  const now = Date.now();
  if (!attempts || now - attempts.firstAt >= WINDOW_MS) attempts = { count: 0, firstAt: now };
  if (attempts.count >= MAX_ATTEMPTS) attempts.lockedUntil ??= now + LOCKOUT_MS;
}
export function recordSuccess(): void { attempts = undefined; }
export function resetRateLimit(): void { attempts = undefined; }
