import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const name = `eclipse-provision-0029-${randomBytes(8).toString("hex")}`;
const label = "eclipse.test.provision-0029";
const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")).entries;
const migrations = journal.map((entry) => ({ ...entry,
  source: readFileSync(`drizzle/${entry.tag}.sql`, "utf8").replace(/\r\n/g, "\n"),
}));
const history = migrations.map((entry) => ({ idx: entry.idx, created_at: entry.when,
  hash_lf: createHash("sha256").update(entry.source).digest("hex"),
  hash_crlf: createHash("sha256").update(entry.source.replace(/\n/g, "\r\n")).digest("hex"),
}));
const provision = readFileSync("db/provision.sql", "utf8").replace(/\r\n/g, "\n");
const docker = (args, input) => spawnSync("docker", args, {
  input, encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024,
});
function checked(result, description) {
  assert.equal(result.status, 0, `${description}: ${result.error ?? ""}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  return result.stdout.trim();
}
const sql = (source, variables = []) => docker(["exec", "-i", name, "psql", "-X", "-U", "eclipse_bootstrap", "-d", "eclipse",
  "-v", "ON_ERROR_STOP=1", ...variables, "-Atf", "-"], source);
function contract(start, error) {
  const offset = provision.indexOf(start);
  assert.ok(offset >= 0, `locate ${error} start`);
  const end = provision.indexOf(`RAISE EXCEPTION '${error}';`, offset);
  assert.ok(end > offset, `locate ${error} end`);
  return `DO $$ BEGIN\n${provision.slice(offset, provision.indexOf("END IF;", end) + 7)}\nEND $$;`;
}
const messages = contract("IF to_regclass('public.teach_recordings') IS NOT NULL AND (\n      to_regclass('public.messages')", "unexpected messages post-0013 schema");
const roles = contract("IF to_regclass('public.model_roles') IS NOT NULL AND (", "unexpected model roles schema");
const policies = contract("IF to_regclass('public.agent_policies') IS NOT NULL AND\n      EXISTS", "unexpected agent policies schema");
const preflight = () => sql(provision, ["-v", "app_new_initial=false", "-v", "migrator_new_initial=false", "-v", `expected_migrations=${JSON.stringify(history)}`]);
let started = false;

test.before(async () => {
  checked(docker(["run", "-d", "--name", name, "--label", `${label}=${name}`, "--network", "none",
    "--tmpfs", "/var/lib/postgresql/data:rw", "-e", "POSTGRES_USER=eclipse_bootstrap", "-e", "POSTGRES_DB=eclipse",
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
    "postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b"]), "start isolated PostgreSQL (no published ports)");
  started = true;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (sql("SELECT 1").status === 0) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ready, "PostgreSQL becomes ready");
  checked(sql("CREATE ROLE eclipse_app LOGIN; CREATE ROLE eclipse_migrator LOGIN; COMMENT ON ROLE eclipse_app IS 'Eclipse Crew TASK-064 managed role'; COMMENT ON ROLE eclipse_migrator IS 'Eclipse Crew TASK-064 managed role'; GRANT CREATE ON DATABASE eclipse TO eclipse_migrator; GRANT USAGE, CREATE ON SCHEMA public TO eclipse_migrator; SET ROLE eclipse_migrator; CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);"), "create managed roles and migration history");
});

test.after(() => {
  if (!started) return;
  assert.equal(checked(docker(["inspect", "--format", `{{ index .Config.Labels "${label}" }}`, name]), "verify disposable container"), name);
  checked(docker(["rm", "-f", "-v", name]), "remove only labeled disposable PostgreSQL");
});

test("exact message/model-role/policy contracts accept historical and 0029 catalogs repeatedly", () => {
  const checkpoints = new Set([6, 8, 14, 29, 30, 31, migrations.length]);
  assert.equal(migrations[7].tag, "0007_luxuriant_ultimatum");
  assert.match(migrations[7].source, /ADD COLUMN "routing"/);
  assert.match(migrations[29].source, /model_roles_background_shape_check/);
  for (let index = 0; index < migrations.length; index++) {
    const entry = migrations[index];
    checked(sql(`BEGIN; SET LOCAL ROLE eclipse_migrator;\n${entry.source.replaceAll("--> statement-breakpoint", "")}\nINSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES ('${history[index].hash_lf}',${entry.when}); COMMIT;`), `apply ${entry.tag}`);
    if (!checkpoints.has(index + 1)) continue;
    for (let repeat = 0; repeat < 2; repeat++) {
      checked(sql(roles), `model-role contract after ${entry.tag}, pass ${repeat + 1}`);
      checked(sql(messages), `message contract after ${entry.tag}, pass ${repeat + 1}`);
      checked(sql(policies), `agent-policy contract after ${entry.tag}, pass ${repeat + 1}`);
    }
  }
});

test("repeated scoped preflights preserve owner rows and migration history", () => {
  checked(sql("INSERT INTO public.owner(id,owner_id,login,password_hash,timezone) VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002','provision-fixture','synthetic-hash','UTC');"), "create disposable owner");
  const snapshot = () => checked(sql("SELECT row_to_json(o) FROM public.owner o; SELECT row_to_json(m) FROM drizzle.__drizzle_migrations m ORDER BY id"), "snapshot owner and migration history");
  const before = snapshot();
  checked(sql(messages + roles), "current message and role preflights");
  checked(sql(messages + roles), "repeat current message and role preflights");
  assert.equal(snapshot(), before, "owner and complete history remain identical");
  assert.equal(checked(docker(["port", name]), "check no published database port"), "");
});

test("0029 same-name message/index/role drift still fails exact catalog checks", () => {
  const cases = [
    ["messages", "ALTER TABLE public.messages DROP CONSTRAINT messages_card_type_check; ALTER TABLE public.messages ADD CONSTRAINT messages_card_type_check CHECK (card_type IN ('message','clarification','tool_connection','routine','file','budget_warning','budget_paused','teach_paused','skill_update','approval','memory_change','memory_saved','memory_tidied','unexpected'));", "messages_card_type_check", "unexpected messages post-0013 schema"],
    ["model_roles", "ALTER TABLE public.model_roles DROP CONSTRAINT model_roles_role_check; ALTER TABLE public.model_roles ADD CONSTRAINT model_roles_role_check CHECK (role IN ('main','sam','background','unexpected'));", "model_roles_role_check", "unexpected model roles schema"],
    ["model_roles", "ALTER TABLE public.model_roles DROP CONSTRAINT model_roles_background_shape_check; ALTER TABLE public.model_roles ADD CONSTRAINT model_roles_background_shape_check CHECK (role <> 'background' OR mode = 'active');", "model_roles_background_shape_check", "unexpected model roles schema"],
  ];
  for (const [table, change, constraint, error] of cases) {
    const definition = checked(sql(`SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.${table}'::regclass AND conname='${constraint}'`), `read ${constraint}`);
    try {
      checked(sql(change), `mutate ${constraint}`);
      const result = sql(table === "messages" ? messages : roles);
      assert.notEqual(result.status, 0, `${constraint} drift denied`);
      assert.ok(result.stderr.includes(error), `specific rejection for ${constraint}: ${result.stderr}`);
    } finally {
      checked(sql(`ALTER TABLE public.${table} DROP CONSTRAINT ${constraint}; ALTER TABLE public.${table} ADD CONSTRAINT ${constraint} ${definition};`), `restore ${constraint}`);
    }
    checked(sql(table === "messages" ? messages : roles), `restored ${constraint} accepted`);
  }
  const definition = checked(sql("SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='messages_search_idx'"), "read search index");
  try {
    checked(sql("DROP INDEX public.messages_search_idx; CREATE INDEX messages_search_idx ON public.messages USING gin (to_tsvector('english', coalesce(content->>'text','')));"), "replace search index with wrong dictionary/expression");
    const result = sql(messages);
    assert.notEqual(result.status, 0, "same-name wrong index rejected");
    assert.match(result.stderr, /unexpected messages post-0013 schema/);
  } finally { checked(sql(`DROP INDEX public.messages_search_idx; ${definition};`), "restore exact search index"); }
  checked(sql(messages), "restored index accepted");
});

test("full current provisioning repeats, preserves data and denies runtime DDL", () => {
  const snapshot = () => checked(sql("SELECT row_to_json(o) FROM public.owner o; SELECT row_to_json(m) FROM drizzle.__drizzle_migrations m ORDER BY id"), "snapshot owner and history");
  const before = snapshot();
  checked(preflight(), "full current provisioning");
  checked(preflight(), "repeat full current provisioning");
  assert.equal(snapshot(), before, "full provisioning preserves owner and migration history");
  const denied = sql("SET ROLE eclipse_app; CREATE TABLE public.denied_fixture(id integer)");
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /permission denied/);
});

test("full provisioning rejects altered policy defaults and constraints without changing grants", () => {
  const snapshot = () => checked(sql("SELECT row_to_json(o) FROM public.owner o; SELECT row_to_json(m) FROM drizzle.__drizzle_migrations m ORDER BY id; SELECT relname, relowner, relacl FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY relname"), "snapshot rows, history, ownership and grants");
  const fixtures = [
    ["ALTER TABLE public.agent_policies ALTER COLUMN memory_mode SET DEFAULT 'ask'", "ALTER TABLE public.agent_policies ALTER COLUMN memory_mode SET DEFAULT 'auto'"],
    ["ALTER TABLE public.agent_policies ALTER COLUMN updated_at SET DEFAULT clock_timestamp()", "ALTER TABLE public.agent_policies ALTER COLUMN updated_at SET DEFAULT now()"],
    ["ALTER TABLE public.agent_policies DROP CONSTRAINT agent_policies_memory_mode_check; ALTER TABLE public.agent_policies ADD CONSTRAINT agent_policies_memory_mode_check CHECK (memory_mode IN ('auto','ask','unexpected'))", "ALTER TABLE public.agent_policies DROP CONSTRAINT agent_policies_memory_mode_check; ALTER TABLE public.agent_policies ADD CONSTRAINT agent_policies_memory_mode_check CHECK (memory_mode IN ('auto','ask'))"],
  ];
  for (const [mutate, restore] of fixtures) {
    try {
      checked(sql(mutate), "alter disposable policy contract");
      const before = snapshot();
      const result = preflight();
      assert.notEqual(result.status, 0, "altered policy contract is denied");
      assert.match(result.stderr, /unexpected agent policies schema/);
      assert.equal(snapshot(), before, "failed provisioning makes no row/history/ownership/grant changes");
    } finally { checked(sql(restore), "restore exact policy contract"); }
    checked(preflight(), "restored policy contract provisions successfully");
  }
});
