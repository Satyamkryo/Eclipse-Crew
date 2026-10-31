import { z } from "zod";
import { getDatabase } from "@/db/client";
import { owner } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { checkRateLimit, recordFailure, recordSuccess } from "@/lib/auth/rate-limit";
import { readBoundedJson, requireTrustedOrigin, requireNoQuery, requestErrorResponse } from "@/lib/auth/request";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ login: z.string().email().max(255), password: z.string().min(1).max(128) }).strict();
export async function POST(req: Request) {
  try {
    requireTrustedOrigin(req);
    requireNoQuery(req);
    const rate = checkRateLimit();
    if (!rate.allowed) return Response.json({ error: "Too many attempts. Try again later.", retryAfter: rate.retryAfter },
      { status: 429, headers: { "Retry-After": String(rate.retryAfter) } });
    const parsed = schema.safeParse(await readBoundedJson(req, 4096));
    if (!parsed.success) { recordFailure(); return Response.json({ error: "Invalid credentials" }, { status: 401 }); }
    const db = await getDatabase();
    const loggedIn = await db.transaction(async (tx) => {
      // Same lock as setup/reset: a stale password cannot create a session after reset.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(691016)`);
      const rows = await tx.select().from(owner).where(eq(owner.login, parsed.data.login.toLowerCase())).limit(1);
      const user = rows[0];
      if (!user || !(await verifyPassword(user.passwordHash, parsed.data.password))) return false;
      await createSession(user.id, tx);
      return true;
    });
    if (!loggedIn) {
      recordFailure(); return Response.json({ error: "Invalid credentials" }, { status: 401 });
    }
    recordSuccess();
    return Response.json({ ok: true });
  } catch (error) { return requestErrorResponse(error); }
}
