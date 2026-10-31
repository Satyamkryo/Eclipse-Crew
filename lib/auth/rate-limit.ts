import "server-only";
// One owner and one bounded bucket: forwarding headers cannot select or evade it.
let attempts: { count: number; firstAt: number; lockedUntil?: number } | undefined;
export function checkRateLimit(): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  if (attempts?.lockedUntil && now < attempts.lockedUntil)
    return { allowed: false, retryAfter: Math.ceil((attempts.lockedUntil - now) / 1000) };
  if (attempts && (attempts.lockedUntil || now - attempts.firstAt >= 5 * 60 * 1000)) attempts = undefined;
  return { allowed: true };
}
export function recordFailure(): void {
  const now = Date.now();
  if (!attempts || now - attempts.firstAt > 5 * 60 * 1000) attempts = { count: 0, firstAt: now };
  attempts.count++;
  if (attempts.count >= 5) attempts.lockedUntil = now + 15 * 60 * 1000;
}
export function recordSuccess(): void { attempts = undefined; }
export function resetRateLimit(): void { attempts = undefined; }
