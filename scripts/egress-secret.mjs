#!/usr/bin/env node
/**
 * Generates the egress-proxy credentials in the local .env file only if they are missing or empty:
 * EGRESS_PROXY_SECRET (app -> proxy) and EGRESS_DESKTOP_SECRET (desktop supervisor -> proxy).
 * See scripts/lib/env-secret.mjs for the shared, hardened write behaviour.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureEnvSecret, reportEnvSecretResult } from "./lib/env-secret.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.join(ROOT, ".env");
const SECRET_KEYS = ["EGRESS_PROXY_SECRET", "EGRESS_DESKTOP_SECRET"];

export async function ensureEgressSecret(envPath = ENV_PATH) {
  for (const key of SECRET_KEYS) reportEnvSecretResult(await ensureEnvSecret({ envPath, key }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureEgressSecret().catch(() => {
    console.error("Unexpected egress secret setup failure.");
    process.exitCode = 1;
  });
}
