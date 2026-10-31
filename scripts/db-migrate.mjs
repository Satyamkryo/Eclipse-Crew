import nextEnv from "@next/env";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pathToFileURL } from "node:url";

function validUrl(value) {
  try {
    const url = new URL(value);
    return ["postgres:", "postgresql:"].includes(url.protocol) && url.username === "eclipse_migrator" &&
      Boolean(url.password) && url.hostname === "postgres" && url.pathname === "/eclipse" && !url.search && !url.hash;
  } catch { return false; }
}
function fail(message) { throw new Error(message); }

// Select only this Compose project's app image and its private database network.
// Passwords are inherited by Docker through named environment variables, never argv.
export function runDatabaseHelper(script, variables, { input, typed = false } = {}) {
  const run = (args) => {
    const result = spawnSync("docker", args, { encoding: "utf8", env: process.env, timeout: 30000 });
    if (result.status !== 0) fail("Docker helper setup failed. Check that the Compose services are running.");
    return result.stdout.trim();
  };
  const postgres = run(["compose", "ps", "-q", "postgres"]);
  const app = run(["compose", "ps", "-q", "app"]);
  if (!postgres || !app || /\s/.test(postgres + app)) fail("Start exactly one Compose app and Postgres first.");
  const describe = (id) => JSON.parse(run(["inspect", id]))[0];
  const postgresInfo = describe(postgres);
  const appInfo = describe(app);
  const project = postgresInfo.Config.Labels?.["com.docker.compose.project"];
  if (!project || postgresInfo.Config.Labels?.["com.docker.compose.service"] !== "postgres" ||
      appInfo.Config.Labels?.["com.docker.compose.project"] !== project ||
      appInfo.Config.Labels?.["com.docker.compose.service"] !== "app" ||
      !/^sha256:[a-f0-9]{64}$/.test(appInfo.Image)) fail("Unverified Compose project or app image.");
  const candidates = Object.keys(postgresInfo.NetworkSettings.Networks).filter((name) => {
    const network = JSON.parse(run(["network", "inspect", name]))[0];
    return network.Internal === true && network.Labels?.["com.docker.compose.project"] === project &&
      network.Labels?.["com.docker.compose.network"] === "database" &&
      Boolean(appInfo.NetworkSettings.Networks[name]);
  });
  if (candidates.length !== 1) fail("Could not identify the private database network.");
  const result = spawnSync("docker", ["run", "--rm", "-i", "--network", candidates[0],
    "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16777216,mode=1777",
    "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user", "node",
    ...variables.flatMap((name) => ["--env", name]), "--entrypoint", "node", appInfo.Image,
    "--conditions=react-server", ...(typed ? ["--import", "tsx"] : []), script, "--inside"],
  { env: process.env, input, stdio: ["pipe", "inherit", "inherit"], timeout: 120000 });
  if (result.status !== 0) fail("Database maintenance helper failed.");
}

export async function main() {
if (process.argv.includes("--inside")) {
  if (!validUrl(process.env.MIGRATION_DATABASE_URL) || process.env.DATABASE_URL) fail("Invalid migration helper configuration.");
  const pool = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, connectionTimeoutMillis: 5000 });
  const database = drizzle({ client: pool });
  let stage = "role connection or verification";
  try {
    const result = await database.execute(sql`SELECT current_user AS current_user, session_user AS session_user,
      r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
      EXISTS (SELECT FROM pg_auth_members WHERE member = r.oid) AS has_memberships
      FROM pg_roles r WHERE r.rolname = current_user`);
    const role = result.rows[0];
    if (!role || role.current_user !== "eclipse_migrator" || role.session_user !== "eclipse_migrator" || role.rolsuper ||
        role.rolcreatedb || role.rolcreaterole || role.rolreplication || role.rolbypassrls || role.has_memberships) throw new Error();
    stage = "Drizzle migration";
    const resultMigration = spawnSync(process.execPath, ["--conditions=react-server", "./node_modules/drizzle-kit/bin.cjs", "migrate"], {
      env: { PATH: process.env.PATH, NODE_ENV: "production", MIGRATION_DATABASE_URL: process.env.MIGRATION_DATABASE_URL },
      stdio: "ignore",
    });
    if (resultMigration.status !== 0) throw new Error();
    stage = "runtime table grant";
    await database.execute(sql`GRANT SELECT, INSERT, UPDATE ON public.owner TO eclipse_app`);
    await database.execute(sql`GRANT SELECT, INSERT, UPDATE, DELETE ON public.sessions TO eclipse_app`);
    await database.execute(sql`GRANT SELECT, INSERT, UPDATE, DELETE ON public.agents TO eclipse_app`);
    await database.execute(sql`GRANT SELECT, INSERT, UPDATE ON public.agent_policies TO eclipse_app`);
    console.log("Database migrations applied.");
  } catch {
    console.error(`Database ${stage} failed.`);
    process.exitCode = 1;
  } finally { await pool.end(); }
} else {
  nextEnv.loadEnvConfig(process.cwd(), false, { info() {}, error() { throw new Error("Unable to load environment configuration."); } });
  if (!validUrl(process.env.MIGRATION_DATABASE_URL)) fail("MIGRATION_DATABASE_URL must use the migration role on postgres/eclipse without URL options.");
  runDatabaseHelper("scripts/db-migrate.mjs", ["MIGRATION_DATABASE_URL"]);
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("Database migration helper failed. Check the private Compose configuration and roles."); process.exitCode = 1; });
}
