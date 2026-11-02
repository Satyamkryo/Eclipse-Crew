import { ChatDataError } from "@/lib/chat/data";
import { requestErrorResponse } from "@/lib/auth/request";

// Safe codes only: no path or internal text reaches the browser.
const STATUS: Record<string, number> = { file_not_found: 404, file_changed: 409, session_not_running: 409, takeover_active: 409, type_blocked: 415,
  agent_not_found: 404, agent_unavailable: 404, upload_busy: 429, download_failed: 503, scan_failed: 503 };
export const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
export function outboxError(error: unknown): Response {
  const raw = error instanceof ChatDataError ? error.code : (error as { code?: string })?.code;
  const code = raw === "forbidden_target" ? "type_blocked" : raw === "target_not_found" ? "file_not_found" : raw;
  if (code && code in STATUS) return Response.json({ error: code }, { status: STATUS[code], headers: NO_STORE });
  const response = requestErrorResponse(error);
  for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
  return response;
}