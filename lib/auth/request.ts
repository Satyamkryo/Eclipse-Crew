import "server-only";
import { requireAppOrigin } from "../config/server";
import { validateCsrfToken } from "./csrf";
import { sessionTokenFromRequest, validateSessionToken } from "./session";

export class RequestError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export function requireTrustedOrigin(request: Request, required = true): void {
  const origin = request.headers.get("origin");
  if (origin === null && !required) return;
  if (origin !== requireAppOrigin()) throw new RequestError(403, "origin_denied");
}
export function requireNoQuery(request: Request): void {
  if (new URL(request.url).search) throw new RequestError(400, "invalid_query");
}
export async function requireOwnerRequest(request: Request, options: { mutation?: boolean } = {}) {
  const session = await validateSessionToken(sessionTokenFromRequest(request));
  if (!session) throw new RequestError(401, "Unauthorized");
  requireTrustedOrigin(request, options.mutation === true);
  if (options.mutation && !validateCsrfToken(request.headers.get("x-csrf-token"), session.csrfToken))
    throw new RequestError(403, "csrf_denied");
  return session;
}
export async function readBoundedJson(request: Request, limit = 16 * 1024): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    throw new RequestError(415, "json_required");
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new RequestError(413, "body_too_large");
  if (!request.body) throw new RequestError(400, "invalid_json");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new RequestError(408, "body_timeout")); void reader.cancel().catch(() => {}); }, 5000);
    });
    while (true) {
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.length;
      if (size > limit) throw new RequestError(413, "body_too_large");
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new RequestError(400, "invalid_json"); }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function requestErrorResponse(error: unknown): Response {
  if (error instanceof RequestError) return Response.json({ error: error.code }, { status: error.status });
  const code = (error as { code?: string })?.code;
  const denied = new Set(["owner_mismatch", "agent_not_owned", "unknown_agent", "agent_not_found"]);
  const conflict = new Set(["session_not_running", "takeover_active", "not_in_takeover", "stale_generation", "invalid_lease", "lease_mismatch", "capture_blocked_during_takeover"]);
  if (code && (denied.has(code) || conflict.has(code)))
    return Response.json({ error: code }, { status: denied.has(code) ? 403 : 409 });
  return Response.json({ error: "service_unavailable" }, { status: 503 });
}
