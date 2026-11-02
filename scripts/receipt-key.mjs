#!/usr/bin/env node
/**
 * Generates RECEIPT_SIGNING_KEY (the install's Ed25519 seed) in the local .env file only if it is missing or empty.
 * See scripts/lib/env-secret.mjs for the shared, hardened write behaviour. The value is never printed.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureEnvSecret, reportEnvSecretResult } from "./lib/env-secret.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.join(ROOT, ".env");
const SECRET_KEY = "RECEIPT_SIGNING_KEY";

export async function ensureReceiptKey(envPath = ENV_PATH) {
  reportEnvSecretResult(await ensureEnvSecret({ envPath, key: SECRET_KEY }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureReceiptKey().catch(() => {
    console.error("Unexpected receipt key setup failure.");
    process.exitCode = 1;
  });
}
