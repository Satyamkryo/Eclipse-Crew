import nextEnv from "@next/env";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { runDatabaseHelper } from "./db-migrate.mjs";
import { readPassword } from "./reset-password.mjs";

const loginSchema = z.string().email().max(255);
const timezoneSchema = z.string().min(1).max(64).refine((value) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
});

export function parseAccountArgs(argv) {
  const [command, ...rest] = argv.filter((arg) => arg !== "--inside");
  if (command !== "create" && command !== "list") throw new Error("Use `account:create --login <email> [--timezone <IANA>]` or `account:list`.");
  let login;
  let timezone = "UTC";
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--login") login = rest[++i];
    else if (arg === "--timezone") timezone = rest[++i];
    else if (arg === "--password" || arg.startsWith("--password=")) throw new Error("Password arguments are refused. Supply the password through private stdin.");
    else throw new Error(`Unknown argument ${arg}.`);
  }
  if (command === "create") {
    const parsedLogin = loginSchema.safeParse(login);
    if (!parsedLogin.success) throw new Error("A valid --login <email> is required.");
    const parsedTimezone = timezoneSchema.safeParse(timezone);
    if (!parsedTimezone.success) throw new Error("Invalid --timezone. Use an IANA name such as Asia/Kolkata.");
    return { command, login: parsedLogin.data.toLowerCase(), timezone: parsedTimezone.data };
  }
  if (rest.length) throw new Error("`account:list` takes no arguments.");
  return { command };
}

// One row per account: id and owner_id match, the login is unique and lowercase.
export async function createOwnerAccount(database, schema, hashPassword, { login, timezone = "UTC", password }) {
  const normalized = loginSchema.parse(login).toLowerCase();
  const zone = timezoneSchema.parse(timezone);
  if (typeof password !== "string" || password.length < 8 || password.length > 128 || /[\r\n\0]/.test(password))
    throw new Error("Invalid password input (8–128 characters, one line).");
  const hash = await hashPassword(password);
  return database.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(691016)`);
    const existing = await transaction.select({ id: schema.owner.id }).from(schema.owner)
      .where(eq(schema.owner.login, normalized)).limit(1);
    if (existing.length) throw new Error(`Login ${normalized} is already taken.`);
    const id = randomUUID();
    await transaction.insert(schema.owner).values({ id, ownerId: id, login: normalized, passwordHash: hash, timezone: zone });
    return { id, login: normalized, timezone: zone };
  });
}

export async function listOwnerAccounts(database, schema) {
  return database.select({ login: schema.owner.login, createdAt: schema.owner.createdAt })
    .from(schema.owner).orderBy(schema.owner.createdAt);
}

export async function main() {
  const parsed = parseAccountArgs(process.argv.slice(2));
  if (process.argv.includes("--inside")) {
    if (process.env.MIGRATION_DATABASE_URL || process.env.POSTGRES_BOOTSTRAP_PASSWORD) throw new Error("Invalid account helper configuration.");
    const url = new URL(process.env.DATABASE_URL);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || url.username !== "eclipse_app" || !url.password ||
        url.hostname !== "postgres" || url.pathname !== "/eclipse" || url.search || url.hash) throw new Error("Invalid account role.");
    const [clientModule, schemaModule, passwordModule] = await Promise.all([
      import("../db/client.ts"), import("../db/schema.ts"), import("../lib/auth/password.ts"),
    ]);
    const { getDatabase } = clientModule.getDatabase ? clientModule : clientModule.default;
    const schema = schemaModule.owner ? schemaModule : schemaModule.default;
    const { hashPassword } = passwordModule.hashPassword ? passwordModule : passwordModule.default;
    if (parsed.command === "list") {
      console.log(JSON.stringify(await listOwnerAccounts(await getDatabase(), schema), null, 2));
      return;
    }
    const password = await readPassword(process.stdin);
    const created = await createOwnerAccount(await getDatabase(), schema, hashPassword, { ...parsed, password });
    console.log(JSON.stringify({ ok: true, id: created.id, login: created.login, timezone: created.timezone }));
    return;
  }
  nextEnv.loadEnvConfig(process.cwd(), false, { info() {}, error() { throw new Error("Unable to load environment configuration."); } });
  if (parsed.command === "list") {
    runDatabaseHelper("scripts/account.mjs", ["DATABASE_URL"], { typed: true }, ["list"]);
    return;
  }
  const password = await readPassword(process.stdin);
  runDatabaseHelper("scripts/account.mjs", ["DATABASE_URL"], { input: `${password}\n`, typed: true },
    ["create", "--login", parsed.login, "--timezone", parsed.timezone]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0), (error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}
