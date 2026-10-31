import "server-only";

import { loadEnvConfig } from "@next/env";
import { defineConfig } from "drizzle-kit";

import { requireDatabaseUrl } from "./lib/config/server";

let migrationUrl = "";
if (process.argv.includes("migrate")) {
  loadEnvConfig(process.cwd(), false, {
    info: () => {},
    error: () => { throw new Error("Unable to load environment configuration."); },
  });
  migrationUrl = requireDatabaseUrl("MIGRATION_DATABASE_URL", process.env.MIGRATION_DATABASE_URL);
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: migrationUrl },
});
