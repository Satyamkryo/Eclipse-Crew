import "server-only";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { and, eq, gt } from "drizzle-orm";
import { getDatabase } from "../../db/client";
import { sessions, owner } from "../../db/schema";
import { requireAppOrigin } from "../config/server";
import { generateCsrfToken } from "./csrf";

export const SESSION_COOKIE = "eclipse_session";
export const SECURE_SESSION_COOKIE = "__Host-eclipse_session";
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
export type OwnerSession = { ownerId: string; sessionId: string; sessionRef: string; csrfToken: string };

export function sessionCookieOptions() {
  const secure = new URL(requireAppOrigin()).protocol === "https:";
  return { name: secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE, httpOnly: true, secure,
    sameSite: "lax" as const, path: "/", maxAge: SESSION_MAX_AGE };
}
function hashToken(token: string): string { return crypto.createHash("sha256").update(token).digest("hex"); }
export function sessionTokenFromRequest(request: Request): string | undefined {
  const name = sessionCookieOptions().name;
  const values = (request.headers.get("cookie") ?? "").split(";").map((item) => item.trim())
    .filter((item) => item.startsWith(`${name}=`));
  if (values.length !== 1) return undefined;
  return values[0].slice(name.length + 1);
}
export async function createSession(ownerId: string, executor?: Pick<Awaited<ReturnType<typeof getDatabase>>, "insert">) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrfToken = generateCsrfToken();
  const id = crypto.randomUUID();
  const db = executor ?? await getDatabase();
  await db.insert(sessions).values({ id, ownerId, tokenHash: hashToken(token), csrfToken,
    expiresAt: new Date(Date.now() + SESSION_MAX_AGE * 1000) });
  const cookieStore = await cookies();
  cookieStore.set({ ...sessionCookieOptions(), value: token });
  return { id, csrfToken };
}
/** Deleted (revoked), expired and orphaned sessions fail closed on every check. */
export async function validateSessionToken(token: string | undefined): Promise<OwnerSession | null> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const db = await getDatabase();
  const rows = await db.select({ sessionId: sessions.id, ownerId: sessions.ownerId, csrfToken: sessions.csrfToken })
    .from(sessions).innerJoin(owner, eq(sessions.ownerId, owner.id))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date()))).limit(1);
  const session = rows[0];
  if (!session) return null;
  return { ...session, sessionRef: hashToken(`eclipse-session:${session.sessionId}`) };
}
export async function validateSession(): Promise<OwnerSession | null> {
  const cookieStore = await cookies();
  return validateSessionToken(cookieStore.get(sessionCookieOptions().name)?.value);
}
export async function destroySession(session: OwnerSession): Promise<void> {
  const db = await getDatabase();
  await db.delete(sessions).where(and(eq(sessions.id, session.sessionId), eq(sessions.ownerId, session.ownerId)));
  const cookieStore = await cookies();
  cookieStore.set({ ...sessionCookieOptions(), value: "", maxAge: 0 });
}
export async function destroyAllSessions(ownerId: string): Promise<void> {
  const db = await getDatabase();
  await db.delete(sessions).where(eq(sessions.ownerId, ownerId));
}
