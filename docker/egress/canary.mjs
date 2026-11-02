import { createHash } from "node:crypto";

// TASK-047. What the proxy can see without TLS interception: a host name or a plain-HTTP request line/header.
export const CANARY_PATTERN = /ecx-[0-9a-f]{32}/;

export function canaryHash(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function lowerDecoded(value) {
  if (typeof value !== "string" || !value) return "";
  try { return decodeURIComponent(value).toLowerCase(); } catch { return value.toLowerCase(); }
}

export function findCanary(value) {
  const match = CANARY_PATTERN.exec(lowerDecoded(value));
  return match ? match[0] : null;
}
