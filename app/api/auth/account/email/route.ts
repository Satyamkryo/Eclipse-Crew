import { z } from "zod";
import { getDatabase } from "@/db/client";
import { changeOwnerEmail } from "@/lib/auth/account";
import { readBoundedJson, requireNoQuery, requireOwnerRequest, requestErrorResponse } from "@/lib/auth/request";
import { checkRateLimit, recordFailure, recordSuccess } from "@/lib/auth/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const emailSchema = z.object({
  login: z.string().email().max(255),
  currentPassword: z.string().min(1).max(128),
}).strict();

export async function POST(request: Request) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const rate = checkRateLimit();
    if (!rate.allowed) return Response.json({ error: "Too many attempts. Try again later.", retryAfter: rate.retryAfter },
      { status: 429, headers: { "Retry-After": String(rate.retryAfter) } });
    const parsed = emailSchema.safeParse(await readBoundedJson(request, 4096));
    if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400 });
    const changed = await changeOwnerEmail(await getDatabase(), session.ownerId,
      parsed.data.currentPassword, parsed.data.login);
    if (!changed) {
      recordFailure();
      return Response.json({ error: "current_password_incorrect" }, { status: 403 });
    }
    recordSuccess();
    return Response.json({ ok: true, login: parsed.data.login.toLowerCase() });
  } catch (error) { return requestErrorResponse(error); }
}
