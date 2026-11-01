#!/usr/bin/env node
/**
 * Generates DESKTOP_CONTROL_SECRET in the local .env file only if it is missing or empty.
 * See scripts/lib/env-secret.mjs for the shared, hardened write behaviour.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureEnvSecret, reportEnvSecretResult } from "./lib/env-secret.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.join(ROOT, ".env");
const SECRET_KEY = "DESKTOP_CONTROL_SECRET";

export async function ensureDesktopSecret(envPath = ENV_PATH) {
  reportEnvSecretResult(await ensureEnvSecret({ envPath, key: SECRET_KEY }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureDesktopSecret().catch(() => {
    console.error("Unexpected desktop secret setup failure.");
    process.exitCode = 1;
  });
}
