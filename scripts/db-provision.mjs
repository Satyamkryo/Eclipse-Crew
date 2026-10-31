import nextEnv from "@next/env";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

nextEnv.loadEnvConfig(process.cwd(), false, { info() {}, error() { throw new Error("Unable to load environment configuration."); } });
const names = ["POSTGRES_BOOTSTRAP_PASSWORD", "POSTGRES_APP_PASSWORD", "POSTGRES_MIGRATOR_PASSWORD"];
const passwords = names.map((name) => process.env[name] ?? "");
if (passwords.some((password) => !/^[A-Za-z0-9]{32,}$/.test(password)) || new Set(passwords).size !== 3) {
  console.error("Provide three distinct passwords of at least 32 randomly generated ASCII letters or digits.");
  process.exit(1);
}
for (const [setting, role, password] of [["DATABASE_URL", "eclipse_app", passwords[1]], ["MIGRATION_DATABASE_URL", "eclipse_migrator", passwords[2]]]) {
  try {
    const url = new URL(process.env[setting]);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.username !== role ||
        decodeURIComponent(url.password) !== password || url.hostname !== "postgres" ||
        url.pathname !== "/eclipse" || url.search || url.hash) throw new Error();
  } catch {
    console.error(`${setting} must match its role password and use postgres/eclipse without URL options.`);
    process.exit(1);
  }
}

const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
const history = journal.entries.map((entry) => {
  const migration = readFileSync(`drizzle/${entry.tag}.sql`, "utf8").replace(/\r\n/g, "\n");
  return { idx: entry.idx, created_at: entry.when,
    hash_lf: createHash("sha256").update(migration).digest("hex"),
    hash_crlf: createHash("sha256").update(migration.replace(/\n/g, "\r\n")).digest("hex") };
});
const shell = String.raw`
set -eu
export PGCONNECT_TIMEOUT=5
IFS= read -r supplied_bootstrap
IFS= read -r supplied_app
IFS= read -r supplied_migrator
[ "$supplied_bootstrap" = "$(cat /run/secrets/postgres_bootstrap_password)" ] || exit 1
[ "$supplied_app" = "$(cat /run/secrets/postgres_app_password)" ] || exit 1
[ "$supplied_migrator" = "$(cat /run/secrets/postgres_migrator_password)" ] || exit 1
unset supplied_bootstrap supplied_app supplied_migrator
PGPASSWORD="$(cat /run/secrets/postgres_bootstrap_password)" psql -h 127.0.0.1 -U eclipse_bootstrap -d eclipse -w -Atc 'SELECT 1' >/dev/null 2>&1 || exit 1
app_new=$(psql -U eclipse_bootstrap -d eclipse -Atc "SELECT NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'eclipse_app')")
migrator_new=$(psql -U eclipse_bootstrap -d eclipse -Atc "SELECT NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'eclipse_migrator')")
if [ "$app_new" = f ]; then PGPASSWORD="$(cat /run/secrets/postgres_app_password)" psql -h 127.0.0.1 -U eclipse_app -d eclipse -w -Atc 'SELECT 1' >/dev/null 2>&1 || exit 1; fi
if [ "$migrator_new" = f ]; then PGPASSWORD="$(cat /run/secrets/postgres_migrator_password)" psql -h 127.0.0.1 -U eclipse_migrator -d eclipse -w -Atc 'SELECT 1' >/dev/null 2>&1 || exit 1; fi
[ "$app_new" = t ] && app_new=true || app_new=false
[ "$migrator_new" = t ] && migrator_new=true || migrator_new=false
{
  if [ "$app_new" = true ]; then cat /run/secrets/postgres_app_password; printf '\n'; cat /run/secrets/postgres_app_password; printf '\n'; fi
  if [ "$migrator_new" = true ]; then cat /run/secrets/postgres_migrator_password; printf '\n'; cat /run/secrets/postgres_migrator_password; printf '\n'; fi
} | psql -U eclipse_bootstrap -d eclipse -w -v ON_ERROR_STOP=1 -v app_new_initial="$app_new" -v migrator_new_initial="$migrator_new" -v expected_migrations="$1" -f /opt/eclipse/provision.sql >/dev/null 2>&1
`;
const result = spawnSync("docker", ["compose", "exec", "-T", "postgres", "sh", "-c", shell, "--", JSON.stringify(history)], { env: process.env, input: `${passwords.join("\n")}\n`, stdio: ["pipe", "ignore", "ignore"] });
if (result.status !== 0) {
  console.error("Database provisioning failed: check that Postgres is running, credentials match the existing volume, and roles and schema match the project. No changes are committed if preflight fails.");
  process.exit(1);
}
console.log("Database roles provisioned and preflight passed.");
