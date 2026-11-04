import nextEnv from "@next/env";
import { pathToFileURL } from "node:url";
import { eq, sql } from "drizzle-orm";
import { runDatabaseHelper } from "./db-migrate.mjs";

export async function readPassword(input) {
  if (input.isTTY) throw new Error("Supply the new password through private stdin; password arguments are refused.");
  const chunks = [];
  let length = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 4096) throw new Error("Invalid password input.");
    chunks.push(buffer);
  }
  const password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  if (password.length < 8 || password.length > 128 || /[\r\n\0]/.test(password)) throw new Error("Invalid password input (8–128 characters, one line).");
  return password;
}

export function parseResetArgs(argv) {
  const args = argv.filter((arg) => arg !== "--inside");
  let login;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--login") login = args[++i];
    else throw new Error("Use `--login <email>`. Password arguments are refused; supply the password through private stdin.");
  }
  if (!login || login.length > 255) throw new Error("Use `--login <email>` to choose the account.");
  return { login: login.toLowerCase() };
}

// TASK-092. Resets one account only and revokes only its sessions; other accounts keep working.
export async function resetOwnerPassword(database, schema, hashPassword, login, password) {
  const normalized = String(login).trim().toLowerCase();
  if (!normalized || normalized.length > 255) throw new Error("Use `--login <email>` to choose the account.");
  const hash = await hashPassword(password);
  await database.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(691016)`);
    const owners = await transaction.select({ id: schema.owner.id, ownerId: schema.owner.ownerId }).from(schema.owner)
      .where(eq(schema.owner.login, normalized)).limit(2).for("update");
    if (owners.length !== 1 || owners[0].id !== owners[0].ownerId) throw new Error("No matching valid owner for --login.");
    const ownerId = owners[0].ownerId;
    await transaction.update(schema.owner).set({ passwordHash: hash }).where(eq(schema.owner.ownerId, ownerId));
    await transaction.delete(schema.sessions).where(eq(schema.sessions.ownerId, ownerId));
  });
}

export async function main() {
  const { login } = parseResetArgs(process.argv.slice(2));
  const password = await readPassword(process.stdin);
  if (process.argv.includes("--inside")) {
    if (process.env.MIGRATION_DATABASE_URL || process.env.POSTGRES_BOOTSTRAP_PASSWORD) throw new Error("Invalid reset helper configuration.");
    const url = new URL(process.env.DATABASE_URL);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || url.username !== "eclipse_app" || !url.password ||
        url.hostname !== "postgres" || url.pathname !== "/eclipse" || url.search || url.hash) throw new Error("Invalid reset role.");
    const [clientModule, schemaModule, passwordModule] = await Promise.all([
      import("../db/client.ts"), import("../db/schema.ts"), import("../lib/auth/password.ts"),
    ]);
    const { getDatabase } = clientModule.getDatabase ? clientModule : clientModule.default;
    const schema = schemaModule.owner ? schemaModule : schemaModule.default;
    const { hashPassword } = passwordModule.hashPassword ? passwordModule : passwordModule.default;
    await resetOwnerPassword(await getDatabase(), schema, hashPassword, login, password);
    console.log(`Password reset for ${login}; that account's sessions revoked.`);
  } else {
    nextEnv.loadEnvConfig(process.cwd(), false, { info() {}, error() { throw new Error("Unable to load environment configuration."); } });
    runDatabaseHelper("scripts/reset-password.mjs", ["DATABASE_URL"], { input: `${password}\n`, typed: true },
      ["--login", login]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0), () => { console.error("Password reset failed. Use private stdin, `--login <email>`, and verify the Compose runtime role and existing owner."); process.exit(1); });
}
