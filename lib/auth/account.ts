import "server-only";
import { and, desc, eq, gt, ne, sql } from "drizzle-orm";
import { getDatabase } from "../../db/client";
import { owner, sessions } from "../../db/schema";
import { hashPassword, verifyPassword } from "./password";
import { recordAudit, type AuditExecutor } from "../security/audit";

type Database = Awaited<ReturnType<typeof getDatabase>>;
const ACCOUNT_LOCK = 691016;

async function lockedOwner(transaction: Parameters<Parameters<Database["transaction"]>[0]>[0], ownerId: string) {
  await transaction.execute(sql`SELECT pg_advisory_xact_lock(${ACCOUNT_LOCK})`);
  const rows = await transaction.select({ id: owner.id, ownerId: owner.ownerId, passwordHash: owner.passwordHash })
    .from(owner).where(eq(owner.ownerId, ownerId)).limit(1).for("update");
  const row = rows[0];
  return row && row.id === row.ownerId ? row : undefined;
}

export async function changeOwnerPassword(
  database: Database, ownerId: string, currentSessionId: string, currentPassword: string, newPassword: string,
): Promise<boolean> {
  const passwordHash = await hashPassword(newPassword);
  return database.transaction(async (transaction) => {
    const current = await lockedOwner(transaction, ownerId);
    if (!current || !(await verifyPassword(current.passwordHash, currentPassword))) return false;
    await transaction.update(owner).set({ passwordHash }).where(eq(owner.ownerId, ownerId));
    await transaction.delete(sessions).where(and(eq(sessions.ownerId, ownerId), ne(sessions.id, currentSessionId)));
    await recordAudit(transaction as unknown as AuditExecutor, ownerId, { kind: "password_changed" });
    return true;
  });
}

export async function changeOwnerEmail(
  database: Database, ownerId: string, currentPassword: string, login: string,
): Promise<boolean> {
  return database.transaction(async (transaction) => {
    const current = await lockedOwner(transaction, ownerId);
    if (!current || !(await verifyPassword(current.passwordHash, currentPassword))) return false;
    await transaction.update(owner).set({ login: login.toLowerCase() }).where(eq(owner.ownerId, ownerId));
    await recordAudit(transaction as unknown as AuditExecutor, ownerId, { kind: "email_changed" });
    return true;
  });
}

export async function revokeOtherSessions(
  database: Database, ownerId: string, currentSessionId: string,
): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction.delete(sessions).where(and(eq(sessions.ownerId, ownerId), ne(sessions.id, currentSessionId)));
    await recordAudit(transaction as unknown as AuditExecutor, ownerId, { kind: "sessions_revoked" });
  });
}

export type AccountSession = { id: string; createdAt: Date; expiresAt: Date; current: boolean };

export async function getAccountOverview(database: Database, ownerId: string, currentSessionId: string) {
  const [owners, activeSessions] = await Promise.all([
    database.select({ login: owner.login, timezone: owner.timezone }).from(owner)
      .where(eq(owner.ownerId, ownerId)).limit(1),
    database.select({ id: sessions.id, createdAt: sessions.createdAt, expiresAt: sessions.expiresAt }).from(sessions)
      .where(and(eq(sessions.ownerId, ownerId), gt(sessions.expiresAt, new Date())))
      .orderBy(desc(sessions.createdAt)),
  ]);
  const account = owners[0];
  if (!account) throw new Error("owner_not_found");
  const safeSessions: AccountSession[] = activeSessions
    .map((session) => ({ ...session, current: session.id === currentSessionId }))
    .sort((a, b) => Number(b.current) - Number(a.current) || b.createdAt.getTime() - a.createdAt.getTime());
  return { login: account.login, timezone: account.timezone, sessions: safeSessions };
}
