import { z } from "zod";
import { getDatabase } from "@/db/client";
import { owner } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { checkRateLimit, normalizeLogin, recordFailure, recordSuccess } from "@/lib/auth/rate-limit";
import { readBoundedJson, requireTrustedOrigin, requireNoQuery, requestErrorResponse } from "@/lib/auth/request";
import { recordAudit } from "@/lib/security/audit";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ login: z.string().email().max(255), password: z.string().min(1).max(128) }).strict();

// An unknown email takes the same argon2 path as a real check, so the reply time reveals nothing.
let dummyHash: Promise<string> | undefined;
async function unknownEmailCheck(password: string): Promise<boolean> {
  dummyHash ??= hashPassword("eclipse-crew-unknown-login");
  await verifyPassword(await dummyHash, password);
  return false;
}

export async function POST(req: Request) {
  let loginKey = "";
  let reserved = false;
  try {
    requireTrustedOrigin(req);
    requireNoQuery(req);
    const parsed = schema.safeParse(await readBoundedJson(req, 4096));
    loginKey = parsed.success ? normalizeLogin(parsed.data.login) : "";
    const rate = checkRateLimit(loginKey);
    if (!rate.allowed) return Response.json({ error: "Too many attempts. Try again later.", retryAfter: rate.retryAfter },
      { status: 429, headers: { "Retry-After": String(rate.retryAfter) } });
    reserved = true;
    if (!parsed.success) { recordFailure(loginKey); return Response.json({ error: "Invalid credentials" }, { status: 401 }); }
    const db = await getDatabase();
    const loggedIn = await db.transaction(async (tx) => {
      // Same lock as setup/reset: a stale password cannot create a session after reset.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(691016)`);
      const rows = await tx.select().from(owner).where(eq(owner.login, parsed.data.login.toLowerCase())).limit(1);
      const user = rows[0];
      if (!user) return unknownEmailCheck(parsed.data.password);
      if (!(await verifyPassword(user.passwordHash, parsed.data.password))) return false;
      const session = await createSession(user.id, tx);
      // TASK-052. Last statement in the login transaction: the session and its audit entry commit together.
      await recordAudit(tx, user.id, { kind: "login", ref: session.id });
      return true;
    });
    if (!loggedIn) {
      recordFailure(loginKey); return Response.json({ error: "Invalid credentials" }, { status: 401 });
    }
    recordSuccess(loginKey);
    return Response.json({ ok: true });
  } catch (error) {
    // A throw after reserving must not burn the login's attempts.
    if (reserved) recordSuccess(loginKey);
    return requestErrorResponse(error);
  }
}
