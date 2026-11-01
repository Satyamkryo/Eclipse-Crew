#!/usr/bin/env node
/**
 * Generates ENCRYPTION_KEY in the local .env file only if it is missing or empty.
 * See scripts/lib/env-secret.mjs for the shared, hardened write behaviour.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureEnvSecret, reportEnvSecretResult } from "./lib/env-secret.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.join(ROOT, ".env");
const SECRET_KEY = "ENCRYPTION_KEY";

export async function ensureEncryptionKey(envPath = ENV_PATH) {
  reportEnvSecretResult(await ensureEnvSecret({ envPath, key: SECRET_KEY }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureEncryptionKey().catch(() => {
    console.error("Unexpected encryption key setup failure.");
    process.exitCode = 1;
  });
}
