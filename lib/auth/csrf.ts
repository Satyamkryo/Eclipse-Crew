import "server-only";
import crypto from "node:crypto";

export function generateCsrfToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function validateCsrfToken(token: string | null | undefined, expected: string): boolean {
  return typeof token === "string" && /^[0-9a-f]{64}$/.test(token) &&
    /^[0-9a-f]{64}$/.test(expected) && crypto.timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(expected, "hex"));
}
