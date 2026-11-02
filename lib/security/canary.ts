import { createHash, randomBytes } from "node:crypto";

// TASK-047. The canary is bait, not a credential. It is generated once per agent, stored encrypted, and matched in
// text the model is about to type. Variants cover the encodings a model or a page could plausibly use to move it.
export const CANARY_PREFIX = "ecx-";
export const CANARY_PATTERN = /ecx-[0-9a-f]{32}/;

export function generateCanary(): string {
  return `${CANARY_PREFIX}${randomBytes(16).toString("hex")}`;
}

export function canaryHash(canary: string): string {
  return createHash("sha256").update(canary, "utf8").digest("hex");
}

export function canaryVariants(canary: string): string[] {
  const body = canary.slice(CANARY_PREFIX.length);
  const bytes = Buffer.from(canary, "utf8");
  return [
    canary,
    canary.toUpperCase(),
    canary.toLowerCase(),
    canary.toLowerCase().replace(/[^a-z0-9]/g, ""),
    body,
    body.toUpperCase(),
    encodeURIComponent(canary),
    encodeURIComponent(canary).toLowerCase(),
    bytes.toString("base64"),
    bytes.toString("base64url"),
    bytes.toString("hex"),
    [...canary].reverse().join(""),
    [...canary.toLowerCase()].reverse().join(""),
  ];
}

// `previousTail` is text from earlier executed `type` steps in the same run. It lets a canary split across two steps match
// without keeping every typed character.
export function containsCanary(text: string, canary: string, previousTail = ""): boolean {
  if (!canary) return false;
  const haystack = `${previousTail}${text}`;
  const lower = haystack.toLowerCase();
  const alnum = lower.replace(/[^a-z0-9]/g, "");
  const variants = new Set(canaryVariants(canary));
  for (const variant of variants) {
    if (!variant) continue;
    if (haystack.includes(variant) || lower.includes(variant.toLowerCase())) return true;
  }
  return alnum.includes(canary.toLowerCase().replace(/[^a-z0-9]/g, ""));
}
