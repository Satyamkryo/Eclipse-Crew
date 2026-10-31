import { z } from "zod";
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { owner } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { readBoundedJson, requireTrustedOrigin, requireNoQuery, requestErrorResponse } from "@/lib/auth/request";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({
  login: z.string().email().max(255), password: z.string().min(8).max(128),
  timezone: z.string().min(1).max(64).refine((value) => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
  }).optional(),
}).strict();
export async function POST(req: Request) {
  try {
    requireTrustedOrigin(req);
    requireNoQuery(req);
    const db = await getDatabase();
    if ((await db.select({ id: owner.id }).from(owner).limit(1)).length)
      return Response.json({ error: "Setup already completed" }, { status: 404 });
    const parsed = schema.safeParse(await readBoundedJson(req, 4096));
    if (!parsed.success) return Response.json({ error: "Invalid input" }, { status: 400 });
    // Hash outside the transaction, then serialize check + insert across processes.
    const passwordHash = await hashPassword(parsed.data.password);
    const created = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(691016)`);
      if ((await tx.select({ id: owner.id }).from(owner).limit(1)).length) return false;
      const id = crypto.randomUUID();
      await tx.insert(owner).values({ id, ownerId: id, login: parsed.data.login.toLowerCase(), passwordHash,
        timezone: parsed.data.timezone || "UTC" });
      return true;
    });
    return created ? Response.json({ ok: true }) : Response.json({ error: "Setup already completed" }, { status: 404 });
  } catch (error) { return requestErrorResponse(error); }
}
