import "server-only";

import { z } from "zod";

export function requireAppOrigin(value: unknown = process.env.APP_ORIGIN ?? "http://127.0.0.1:3000"): string {
  try {
    if (typeof value !== "string") throw new Error();
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash || value !== url.origin) throw new Error();
    return url.origin;
  } catch {
    throw new Error("APP_ORIGIN must be an exact HTTP(S) origin without credentials, path or query.");
  }
}

type DatabaseSetting = "DATABASE_URL" | "MIGRATION_DATABASE_URL";

const postgresUrl = z.string().refine((value) => {
  if (!value || value !== value.trim()) return false;

  try {
    const url = new URL(value);
    return (
      (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      Boolean(url.hostname) &&
      url.pathname.length > 1
    );
  } catch {
    return false;
  }
});

export function requireDatabaseUrl(name: DatabaseSetting, value: unknown): string {
  const result = postgresUrl.safeParse(value);
  if (!result.success) {
    throw new Error(`${name} must be a PostgreSQL URL with a host and database name.`);
  }
  const url = new URL(result.data);
  const expected = name === "DATABASE_URL" ? "eclipse_app" : "eclipse_migrator";
  if (url.username !== expected || !url.password || url.search || url.hash) {
    throw new Error(`${name} must use the designated database role and a password without URL options.`);
  }
  return result.data;
}

export function requireEncryptionKey(value: unknown = process.env.ENCRYPTION_KEY): string {
  const result = z.string().regex(/^[0-9a-f]{64}$/).safeParse(value);
  if (!result.success)
    throw new Error(
      "ENCRYPTION_KEY must be a 64-character lowercase hex string. Run npm run encryption-key to generate it.",
    );
  return result.data;
}

export function requireDesktopControlSecret(value: unknown): string {
  const result = z.string().regex(/^[0-9a-f]{64}$/).safeParse(value);
  if (!result.success)
    throw new Error(
      "DESKTOP_CONTROL_SECRET must be a 64-character lowercase hex string. Run npm run desktop:secret to generate it.",
    );
  return result.data;
}
