import "server-only";
// TASK-092. One bucket per login plus a global ceiling. Forwarded headers cannot select or evict a bucket:
// the key is the normalized login from the request body, never a header.
type Bucket = { count: number; firstAt: number; lockedUntil?: number };
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 5 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
// Caps password spraying across many logins. Tripping it locks every login briefly.
const GLOBAL_MAX = 50;
const GLOBAL_WINDOW_MS = 5 * 60 * 1000;
const GLOBAL_LOCKOUT_MS = 5 * 60 * 1000;
const buckets = new Map<string, Bucket>();
let globalBucket: Bucket | undefined;

export function normalizeLogin(login: unknown): string {
  return typeof login === "string" ? login.trim().toLowerCase().slice(0, 255) : "";
}

// A bucket that is still locked stays; an expired lock or an elapsed window restarts fresh.
function live(bucket: Bucket | undefined, now: number, windowMs: number): Bucket | undefined {
  if (!bucket) return undefined;
  if (bucket.lockedUntil && now < bucket.lockedUntil) return bucket;
  if (bucket.lockedUntil || now - bucket.firstAt >= windowMs) return undefined;
  return bucket;
}

// Reserves one attempt: call before checking the password, then recordFailure/recordSuccess.
export function checkRateLimit(login?: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  globalBucket = live(globalBucket, now, GLOBAL_WINDOW_MS);
  if (globalBucket?.lockedUntil && now < globalBucket.lockedUntil)
    return { allowed: false, retryAfter: Math.ceil((globalBucket.lockedUntil - now) / 1000) };
  const key = normalizeLogin(login);
  let bucket = live(buckets.get(key), now, WINDOW_MS);
  if (bucket?.lockedUntil && now < bucket.lockedUntil)
    return { allowed: false, retryAfter: Math.ceil((bucket.lockedUntil - now) / 1000) };
  bucket ??= { count: 0, firstAt: now };
  buckets.set(key, bucket);
  bucket.count++;
  if (bucket.count >= MAX_ATTEMPTS) bucket.lockedUntil = now + LOCKOUT_MS;
  return { allowed: true };
}

export function recordFailure(login?: string): void {
  const now = Date.now();
  globalBucket ??= { count: 0, firstAt: now };
  if (now - globalBucket.firstAt >= GLOBAL_WINDOW_MS) globalBucket = { count: 0, firstAt: now };
  globalBucket.count++;
  if (globalBucket.count >= GLOBAL_MAX) globalBucket.lockedUntil = now + GLOBAL_LOCKOUT_MS;
  const bucket = buckets.get(normalizeLogin(login));
  if (bucket && bucket.count >= MAX_ATTEMPTS) bucket.lockedUntil ??= now + LOCKOUT_MS;
}

export function recordSuccess(login?: string): void {
  if (login === undefined) {
    buckets.clear();
    globalBucket = undefined;
    return;
  }
  buckets.delete(normalizeLogin(login));
}

export function resetRateLimit(login?: string): void {
  if (login === undefined) {
    buckets.clear();
    globalBucket = undefined;
    return;
  }
  buckets.delete(normalizeLogin(login));
}
