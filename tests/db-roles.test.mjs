import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const project = `eclipse064test${randomBytes(6).toString("hex")}`;
const bootstrap = randomBytes(24).toString("hex");
const appPassword = randomBytes(24).toString("hex");
const migratorPassword = randomBytes(24).toString("hex");
const desktopSecret = randomBytes(32).toString("hex");
const env = { ...process.env, COMPOSE_PROJECT_NAME: project, POSTGRES_BOOTSTRAP_PASSWORD: bootstrap,
  POSTGRES_APP_PASSWORD: appPassword, POSTGRES_MIGRATOR_PASSWORD: migratorPassword,
  DESKTOP_CONTROL_SECRET: desktopSecret, APP_ORIGIN: "http://127.0.0.1:3000",
  DATABASE_URL: `postgresql://eclipse_app:${appPassword}@postgres:5432/eclipse`,
  MIGRATION_DATABASE_URL: `postgresql://eclipse_migrator:${migratorPassword}@postgres:5432/eclipse` };
const docker = (args, options = {}) => spawnSync("docker", args, { env, encoding: "utf8", timeout: 300000, ...options });
const compose = (...args) => docker(["compose", ...args]);
const checked = (result, description) => {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  for (const secret of [bootstrap, appPassword, migratorPassword, desktopSecret]) assert.ok(!output.includes(secret), `${description} leaked a synthetic password`);
  assert.equal(result.status, 0, `${description}: ${output}`);
  return result.stdout.trim();
};
const cleanup = () => {
  const containers = checked(docker(["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`]), "identify test containers").split(/\r?\n/).filter(Boolean);
  for (const container of containers) assert.equal(checked(docker(["inspect", "--format", '{{ index .Config.Labels "com.docker.compose.project" }}', container]), "verify container label"), project);
  const networks = checked(docker(["network", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`]), "identify test networks").split(/\r?\n/).filter(Boolean);
  for (const network of networks) assert.equal(checked(docker(["network", "inspect", "--format", '{{ index .Labels "com.docker.compose.project" }}', network]), "verify network label"), project);
  const volumes = checked(docker(["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`]), "identify test volumes").split(/\r?\n/).filter(Boolean);
  for (const volume of volumes) assert.equal(checked(docker(["volume", "inspect", "--format", '{{ index .Labels "com.docker.compose.project" }}', volume]), "verify volume label"), project);
  checked(compose("down", "--volumes", "--remove-orphans"), "remove isolated project");
};
test.after(() => {
  const tag = `${project}-app:latest`;
  const inspected = docker(["image", "inspect", "--format", "{{json .RepoTags}}", tag]);
  if (inspected.status !== 0) return;
  assert.ok(JSON.parse(inspected.stdout).includes(tag), "verify disposable image tag");
  checked(docker(["image", "rm", tag]), "remove disposable image tag");
});

test("isolated database provisioning and permissions", { timeout: 900000 }, async () => {
  try {
    checked(compose("up", "-d", "--build", "app"), "start disposable services");
    const provision = () => spawnSync(process.execPath, ["scripts/db-provision.mjs"], { env, encoding: "utf8", timeout: 60000 });
    const migrate = () => spawnSync(process.execPath, ["scripts/db-migrate.mjs"], { env, encoding: "utf8", timeout: 120000 });
    checked(provision(), "fresh provisioning");
    checked(provision(), "repeat provisioning");
    checked(migrate(), "fresh migration");
    checked(migrate(), "repeat migration");
    const container = checked(compose("ps", "-q", "postgres"), "find postgres");
    const appContainer = checked(compose("ps", "-q", "app"), "find app");
    const sql = (query, role = "eclipse_bootstrap") => {
      const commandEnv = { ...env, PGPASSWORD: role === "eclipse_app" ? appPassword : bootstrap };
      return docker(["exec", "--env", "PGPASSWORD", container, "psql", "-h", "127.0.0.1", "-U", role, "-d", "eclipse", "-v", "ON_ERROR_STOP=1", "-Atc", query], { env: commandEnv });
    };
    assert.equal(checked(sql("SELECT count(*) FROM pg_roles WHERE rolname IN ('eclipse_app','eclipse_migrator') AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls"), "check role attributes"), "2");
    assert.equal(checked(sql("SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname IN ('eclipse_app','eclipse_migrator')"), "check role memberships"), "0");
    const concurrentInsert = (suffix) => new Promise((resolve) => {
      const query = `INSERT INTO public.owner(id,owner_id,login,password_hash,timezone) VALUES ('00000000-0000-0000-0000-00000000000${suffix}','00000000-0000-0000-0000-00000000000${suffix}','owner${suffix}','hash','UTC')`;
      const child = spawn("docker", ["exec", "--env", "PGPASSWORD", container, "psql", "-h", "127.0.0.1", "-U", "eclipse_app", "-d", "eclipse", "-v", "ON_ERROR_STOP=1", "-Atc", query], { env: { ...env, PGPASSWORD: appPassword }, stdio: "ignore" });
      child.on("close", (status) => resolve(status));
      child.on("error", () => resolve(-1));
    });
    const inserts = await Promise.all([concurrentInsert(1), concurrentInsert(2)]);
    assert.equal(inserts.filter((status) => status === 0).length, 1, "exactly one concurrent owner insert succeeds");
    assert.equal(checked(sql("SELECT count(*) FROM public.owner"), "singleton invariant"), "1");
    checked(sql("UPDATE public.owner SET login = 'owner'", "eclipse_app"), "normalize synthetic login");
    checked(sql("UPDATE public.owner SET timezone = 'Asia/Kolkata'", "eclipse_app"), "runtime update");
    assert.equal(checked(sql("SELECT login FROM public.owner", "eclipse_app"), "runtime select"), "owner");
    checked(sql("INSERT INTO public.sessions(id,owner_id,token_hash,csrf_token,expires_at) SELECT '00000000-0000-0000-0000-000000000010',id,'synthetic-token-hash','synthetic-csrf',now() + interval '1 hour' FROM public.owner", "eclipse_app"), "create synthetic session");
    checked(sql("INSERT INTO public.agents(id,owner_id,name,role,soul_md,status,daily_budget_cents,monthly_budget_cents) SELECT '00000000-0000-0000-0000-000000000020',id,'synthetic','role','soul','paused',100,1000 FROM public.owner", "eclipse_app"), "create synthetic agent");
    checked(sql("INSERT INTO public.agent_policies(agent_id,owner_id,tools,domains,actions,memory_scopes) VALUES ('00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000001',ARRAY['tool'],ARRAY['example.com'],ARRAY['read'],ARRAY['agent'])", "eclipse_app"), "create synthetic agent policy");
    assert.equal(checked(sql("SELECT count(*) FROM public.agent_policies", "eclipse_app"), "runtime reads agent policies"), "1");
    assert.notEqual(sql("DELETE FROM public.agent_policies", "eclipse_app").status, 0, "runtime cannot delete policies directly");
    checked(sql("DELETE FROM public.agents WHERE id='00000000-0000-0000-0000-000000000020'", "eclipse_app"), "runtime deletes owned agent and cascades policy");
    assert.equal(checked(sql("SELECT count(*) FROM public.agent_policies", "eclipse_app"), "agent policy cascade"), "0");
    checked(provision(), "populated sessions and singleton provisioning");
    assert.equal(checked(sql("SELECT count(*) FROM public.sessions"), "preserve sessions"), "1");
    checked(sql("ALTER TABLE public.sessions ADD COLUMN unexpected text"), "unknown sessions schema fixture");
    assert.notEqual(provision().status, 0, "unknown sessions columns fail closed");
    checked(sql("ALTER TABLE public.sessions DROP COLUMN unexpected"), "restore supported sessions schema");
    checked(sql("DROP INDEX public.sessions_owner_id_idx; CREATE INDEX sessions_owner_id_idx ON public.sessions(expires_at)"), "wrong known-name index fixture");
    assert.notEqual(provision().status, 0, "wrong known-name index fails closed");
    checked(sql("DROP INDEX public.sessions_owner_id_idx; CREATE INDEX sessions_owner_id_idx ON public.sessions(owner_id)"), "restore supported index");
    const resetPassword = "SYNTHETIC reset fixture 2026";
    const reset = () => spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/reset-password.mjs"], { env, input: `${resetPassword}\n`, encoding: "utf8", timeout: 120000 });
    checked(sql("REVOKE DELETE ON public.sessions FROM eclipse_app"), "deny reset revocation fixture");
    try {
      assert.notEqual(reset().status, 0, "failed revocation rejects reset");
      assert.equal(checked(sql("SELECT password_hash FROM public.owner"), "password rollback"), "hash");
      assert.equal(checked(sql("SELECT count(*) FROM public.sessions"), "session rollback"), "1");
    } finally { checked(sql("GRANT DELETE ON public.sessions TO eclipse_app"), "restore session grant"); }
    checked(sql("INSERT INTO public.sessions(id,owner_id,token_hash,csrf_token,expires_at) VALUES ('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000099','unrelated-owner-hash','unrelated-csrf',now() + interval '1 hour')", "eclipse_app"), "create unrelated-owner session fixture");
    const resetResult = reset();
    assert.ok(!(resetResult.stdout + resetResult.stderr).includes(resetPassword), "reset never prints plaintext password");
    checked(resetResult, "private-stdin reset through app image/private network");
    assert.equal(checked(sql("SELECT count(*) FROM public.sessions s JOIN public.owner o ON o.id=s.owner_id"), "reset revokes owner sessions"), "0");
    assert.equal(checked(sql("SELECT count(*) FROM public.sessions WHERE owner_id='00000000-0000-0000-0000-000000000099'"), "reset preserves unrelated-owner session"), "1");
    const verify = docker(["exec", "-i", appContainer, "node", "--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", "import pg from 'pg'; import { readFileSync } from 'node:fs'; const m=await import('./lib/auth/password.ts'); const {verifyPassword}=m.verifyPassword?m:m.default; const pool = new pg.Pool({connectionString:process.env.DATABASE_URL}); const result=await pool.query('SELECT password_hash FROM public.owner'); const ok=await verifyPassword(result.rows[0].password_hash,readFileSync(0,'utf8')); await pool.end(); process.exit(ok?0:1);"], { input: resetPassword });
    checked(verify, "new Argon2 password verifies");
    for (const query of ["CREATE TABLE public.bad(id int)", "ALTER TABLE public.owner ADD COLUMN bad int", "DROP TABLE public.owner", "CREATE SCHEMA bad", "DROP SCHEMA public", "CREATE TEMP TABLE bad(id int)", "CREATE ROLE bad", "SET ROLE eclipse_migrator", "SET ROLE eclipse_bootstrap", "DELETE FROM public.owner", "SELECT * FROM drizzle.__drizzle_migrations"]) {
      assert.notEqual(sql(query, "eclipse_app").status, 0, `runtime must be denied: ${query}`);
    }
    checked(sql("CREATE TABLE public.unrelated(id int)"), "create incompatible fixture");
    assert.notEqual(sql("SELECT * FROM public.unrelated", "eclipse_app").status, 0, "unrelated table is private");
    assert.notEqual(provision().status, 0, "preflight must reject an unrelated object");
    assert.equal(checked(sql("SELECT count(*) FROM public.owner"), "preserve owner after failed preflight"), "1");
    checked(sql("DROP TABLE public.unrelated"), "remove disposable fixture");
    checked(sql("ALTER TABLE public.owner OWNER TO eclipse_bootstrap; ALTER TABLE drizzle.__drizzle_migrations OWNER TO eclipse_bootstrap; ALTER SCHEMA drizzle OWNER TO eclipse_bootstrap"), "simulate existing bootstrap-owned database");
    checked(provision(), "populated provisioning");
    assert.equal(checked(sql("SELECT count(*) FROM public.owner"), "preserve owner"), "1");
    assert.equal(checked(sql("SELECT count(*) FROM drizzle.__drizzle_migrations"), "preserve history"), "4");
    assert.equal(checked(sql("SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.owner'::regclass"), "transfer owner table"), "eclipse_migrator");
    checked(sql("COMMENT ON ROLE eclipse_app IS 'unrelated fixture'"), "simulate role collision");
    assert.notEqual(provision().status, 0, "preflight must reject unrelated roles");
    assert.equal(checked(sql("SELECT count(*) FROM public.owner"), "preserve owner after role collision"), "1");
    checked(sql("COMMENT ON ROLE eclipse_app IS 'Eclipse Crew TASK-064 managed role'"), "restore fixture marker");
    checked(sql("INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES ('unexpected-test-migration',2)"), "create incompatible history fixture");
    assert.notEqual(provision().status, 0, "preflight must reject unexpected migration history");
    checked(sql("DELETE FROM drizzle.__drizzle_migrations WHERE hash = 'unexpected-test-migration'"), "remove disposable history fixture");
    checked(sql("ALTER DEFAULT PRIVILEGES FOR ROLE eclipse_migrator IN SCHEMA public GRANT UPDATE ON TABLES TO eclipse_app"), "create unsafe default privileges fixture");
    assert.notEqual(provision().status, 0, "preflight must reject blanket future privileges");
    checked(sql("ALTER DEFAULT PRIVILEGES FOR ROLE eclipse_migrator IN SCHEMA public REVOKE UPDATE ON TABLES FROM eclipse_app"), "remove disposable privilege fixture");
    checked(sql("GRANT SELECT ON public.owner TO PUBLIC"), "create unexpected grant fixture");
    assert.notEqual(provision().status, 0, "preflight must reject unexpected existing grants");
    checked(sql("REVOKE SELECT ON public.owner FROM PUBLIC"), "remove disposable grant fixture");
    const otherPassword = randomBytes(24).toString("hex");
    const changedEnv = { ...env, POSTGRES_APP_PASSWORD: otherPassword, DATABASE_URL: `postgresql://eclipse_app:${otherPassword}@postgres:5432/eclipse` };
    const changed = spawnSync(process.execPath, ["scripts/db-provision.mjs"], { env: changedEnv, encoding: "utf8", timeout: 60000 });
    assert.notEqual(changed.status, 0, "different mounted credentials must be rejected");
    assert.ok(!(changed.stdout + changed.stderr).includes(otherPassword));
    assert.equal(checked(sql("SELECT login FROM public.owner", "eclipse_app"), "original runtime password remains valid"), "owner");
    assert.equal(checked(docker(["port", container]), "no published database port"), "");
    const runtimeCheck = () => docker(["exec", appContainer, "node", "--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", "import('./db/client.ts').then(m => (m.getDatabase ?? m.default.getDatabase)()).then(() => process.exit(0), () => process.exit(1))"]);
    checked(runtimeCheck(), "restricted runtime role accepted");
    checked(sql("ALTER ROLE eclipse_app SUPERUSER"), "temporarily elevate disposable role");
    try { assert.notEqual(runtimeCheck().status, 0, "runtime must reject privileged authenticated identity"); }
    finally { checked(sql("ALTER ROLE eclipse_app NOSUPERUSER"), "restore disposable role"); }
    checked(sql("GRANT DELETE ON public.owner TO eclipse_app"), "temporarily grant extra owner privileges");
    try { assert.notEqual(runtimeCheck().status, 0, "runtime must reject extra owner privileges"); }
    finally { checked(sql("REVOKE DELETE ON public.owner FROM eclipse_app"), "restore owner privileges"); }
    const inspectResult = docker(["inspect", "--format", "{{json .Config.Env}}", appContainer]);
    assert.equal(inspectResult.status, 0, "inspect app environment");
    const inspection = inspectResult.stdout;
    assert.ok(!inspection.includes(bootstrap) && !inspection.includes(migratorPassword));
    checked(compose("logs", "--no-color"), "check service logs");
  } finally {
    cleanup();
  }
});

for (const depth of [1, 2]) {
for (const ending of ["LF", "CRLF"]) {
test(`upgrade existing bootstrap-owned ${depth === 1 ? "owner" : "sessions"} database with ${ending} history without losing data`, { timeout: 900000 }, () => {
  try {
    checked(compose("up", "-d", "app"), "start legacy fixture");
    const container = checked(compose("ps", "-q", "postgres"), "find legacy postgres");
    const normalized = readFileSync("drizzle/0000_solid_risque.sql", "utf8").replace(/\r\n/g, "\n");
    const migration = ending === "LF" ? normalized : normalized.replace(/\n/g, "\r\n");
    const hash = createHash("sha256").update(migration).digest("hex");
    checked(docker(["exec", "-i", container, "psql", "-U", "eclipse_bootstrap", "-d", "eclipse", "-v", "ON_ERROR_STOP=1", "-f", "-"], { input: migration }), "apply legacy migration");
    const fixture = "CREATE SCHEMA drizzle;\nCREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);\nINSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES (:'migration_hash',1793293249789);\nINSERT INTO public.owner(id,owner_id,login,password_hash,timezone) VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002','legacy','hash','UTC');\n";
    checked(docker(["exec", "-i", container, "psql", "-U", "eclipse_bootstrap", "-d", "eclipse", "-v", "ON_ERROR_STOP=1", "-v", `migration_hash=${hash}`, "-f", "-"], { input: fixture }), "create legacy fixture");
    if (depth === 2) {
      const sessions = readFileSync("drizzle/0001_noble_moon.sql", "utf8").replace(/\r\n/g, "\n");
      const secondMigration = ending === "LF" ? sessions : sessions.replace(/\n/g, "\r\n");
      const secondHash = createHash("sha256").update(secondMigration).digest("hex");
      checked(docker(["exec", "-i", container, "psql", "-U", "eclipse_bootstrap", "-d", "eclipse", "-v", "ON_ERROR_STOP=1", "-f", "-"], { input: secondMigration }), "apply legacy sessions migration");
      checked(docker(["exec", "-i", container, "psql", "-U", "eclipse_bootstrap", "-d", "eclipse", "-v", "ON_ERROR_STOP=1", "-v", `migration_hash=${secondHash}`, "-f", "-"], { input: "INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES (:'migration_hash',1793404360013); INSERT INTO public.sessions(id,owner_id,token_hash,csrf_token,expires_at) VALUES ('00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000002','legacy-hash','legacy-csrf',now() + interval '1 hour');" }), "record legacy sessions history");
    }
    const provision = () => spawnSync(process.execPath, ["scripts/db-provision.mjs"], { env, encoding: "utf8", timeout: 60000 });
    checked(provision(), "provision legacy volume");
    checked(provision(), "repeat legacy provisioning");
    if (depth === 1 && ending === "LF") {
      const duplicateFixture = "INSERT INTO public.owner(id,owner_id,login,password_hash,timezone) VALUES ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000003','second-legacy','hash','UTC')";
      checked(docker(["exec", container, "psql", "-U", "eclipse_bootstrap", "-d", "eclipse", "-v", "ON_ERROR_STOP=1", "-Atc", duplicateFixture]), "create multiple-owner legacy fixture");
      assert.notEqual(spawnSync(process.execPath, ["scripts/db-migrate.mjs"], { env, encoding: "utf8", timeout: 120000 }).status, 0, "multiple-owner upgrade must fail");
      assert.equal(checked(docker(["exec", container, "psql", "-U", "eclipse_bootstrap", "-d", "eclipse", "-Atc", "SELECT (SELECT count(*) FROM public.owner), (SELECT count(*) FROM drizzle.__drizzle_migrations)"]), "failed migration preserves every owner and history"), "2|1");
      checked(docker(["exec", container, "psql", "-U", "eclipse_bootstrap", "-d", "eclipse", "-v", "ON_ERROR_STOP=1", "-Atc", "DELETE FROM public.owner WHERE id='00000000-0000-0000-0000-000000000003'"]), "remove exact disposable duplicate fixture");
    }
    checked(spawnSync(process.execPath, ["scripts/db-migrate.mjs"], { env, encoding: "utf8", timeout: 120000 }), "migrate legacy volume");
    checked(provision(), "provision upgraded volume again");
    checked(spawnSync(process.execPath, ["scripts/db-migrate.mjs"], { env, encoding: "utf8", timeout: 120000 }), "repeat legacy migration");
    const result = docker(["exec", container, "psql", "-U", "eclipse_bootstrap", "-d", "eclipse", "-Atc", "SELECT (SELECT count(*) FROM public.owner), (SELECT count(*) FROM drizzle.__drizzle_migrations), pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.owner'::regclass))"]);
    assert.equal(checked(result, "verify legacy data and ownership"), "1|4|eclipse_migrator");
    assert.equal(checked(docker(["exec", container, "psql", "-U", "eclipse_bootstrap", "-d", "eclipse", "-Atc", "SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at=1793293249789"]), "verify original history is unchanged"), hash);
    assert.equal(checked(docker(["exec", container, "psql", "-U", "eclipse_bootstrap", "-d", "eclipse", "-Atc", "SELECT count(*) FROM public.sessions"]), "verify legacy sessions are preserved"), depth === 2 ? "1" : "0");
  } finally { cleanup(); }
});
}
}
