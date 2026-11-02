import "server-only";

const LIMIT = 5;
const WINDOW_MS = 60_000;
let attempts: number[] = [];

export function checkConnectionTestRateLimit(now = Date.now()): { allowed: boolean; retryAfter?: number } {
  attempts = attempts.filter((timestamp) => now - timestamp < WINDOW_MS);
  if (attempts.length >= LIMIT) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((attempts[0] + WINDOW_MS - now) / 1000)) };
  }
  attempts.push(now);
  return { allowed: true };
}

export function resetConnectionTestRateLimit(): void {
  attempts = [];
}
