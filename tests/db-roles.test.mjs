import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const project = `eclipse064test${randomBytes(6).toString("hex")}`;
const EXPECTED_MIGRATIONS = String(JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")).entries.length);
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
  if (result.status !== 0 && description === "restored exact teach/audio contracts") {
    // Tail the log: a full `compose logs` exceeds spawnSync's 1 MiB buffer, which
    // keeps the first megabyte, so slicing it would show stale early errors.
    const logs = compose("logs", "--no-color", "--tail", "30", "postgres");
    const errors = `${logs.stdout ?? ""}${logs.stderr ?? ""}`.split(/\r?\n/).filter((line) => line.includes("ERROR:")).slice(-3).join("\n");
    assert.ok(![bootstrap, appPassword, migratorPassword, desktopSecret].some((secret) => errors.includes(secret)), "diagnostic excludes synthetic secrets");
    console.error("[DEBUG-db-closeout]", errors);
  }
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
    // Environment workaround (Docker policy unchanged): this Docker Desktop refuses compose-managed
    // builds that request the fs.read entitlement, so the app image is built directly from its explicit
    // context/Dockerfile first under this run's unique project tag; compose then starts with --no-build.
    checked(docker(["build", "--file", "Dockerfile", "--tag", `${project}-app:latest`, "."]), "direct app image build");
    checked(compose("up", "-d", "--no-build", "app"), "start disposable services");
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
    checked(sql("ALTER TABLE public.agents DROP CONSTRAINT agents_daily_budget_check; ALTER TABLE public.agents ADD CONSTRAINT agents_daily_budget_check CHECK (daily_budget_cents >= 0)"), "weaken agent budget check fixture");
    assert.notEqual(provision().status, 0, "weakened agent budget definition fails closed");
    checked(sql("ALTER TABLE public.agents DROP CONSTRAINT agents_daily_budget_check; ALTER TABLE public.agents ADD CONSTRAINT agents_daily_budget_check CHECK (daily_budget_cents between 1 and 100000000)"), "restore agent budget check");
    checked(sql("ALTER TABLE public.agent_policies DROP CONSTRAINT agent_policies_tools_check; ALTER TABLE public.agent_policies ADD CONSTRAINT agent_policies_tools_check CHECK (cardinality(tools) <= 100)"), "weaken policy cardinality fixture");
    assert.notEqual(provision().status, 0, "weakened policy cardinality definition fails closed");
    checked(sql("ALTER TABLE public.agent_policies DROP CONSTRAINT agent_policies_tools_check; ALTER TABLE public.agent_policies ADD CONSTRAINT agent_policies_tools_check CHECK (cardinality(tools) <= 64)"), "restore policy cardinality check");
    checked(sql("ALTER TABLE public.agents DROP CONSTRAINT agents_status_check; ALTER TABLE public.agents ADD CONSTRAINT agents_status_check CHECK (status in ('active','paused','archived'))"), "weaken agent status fixture");
    assert.notEqual(provision().status, 0, "weakened agent status definition fails closed");
    checked(sql("ALTER TABLE public.agents DROP CONSTRAINT agents_status_check; ALTER TABLE public.agents ADD CONSTRAINT agents_status_check CHECK (status in ('active','paused'))"), "restore agent status check");
    checked(sql("ALTER TABLE public.agent_policies DROP CONSTRAINT agent_policies_agent_id_agents_id_fk; ALTER TABLE public.agent_policies ADD CONSTRAINT agent_policies_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE NO ACTION"), "weaken policy cascade fixture");
    assert.notEqual(provision().status, 0, "weakened policy cascade definition fails closed");
    checked(sql("ALTER TABLE public.agent_policies DROP CONSTRAINT agent_policies_agent_id_agents_id_fk; ALTER TABLE public.agent_policies ADD CONSTRAINT agent_policies_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE"), "restore policy cascade");
    checked(sql("ALTER TABLE public.messages DROP CONSTRAINT messages_source_tag_check; ALTER TABLE public.messages ADD CONSTRAINT messages_source_tag_check CHECK (source_tag in ('user','agent','tool','system','web'))"), "weaken message source fixture");
    assert.notEqual(provision().status, 0, "weakened message source definition fails closed");
    checked(sql("ALTER TABLE public.messages DROP CONSTRAINT messages_source_tag_check; ALTER TABLE public.messages ADD CONSTRAINT messages_source_tag_check CHECK (source_tag in ('user','agent','tool','system'))"), "restore message source check");
    checked(sql("ALTER TABLE public.messages DROP CONSTRAINT messages_session_id_chat_sessions_id_fk; ALTER TABLE public.messages ADD CONSTRAINT messages_session_id_chat_sessions_id_fk FOREIGN KEY (session_id) REFERENCES public.chat_sessions(id) ON DELETE NO ACTION"), "weaken message cascade fixture");
    assert.notEqual(provision().status, 0, "weakened message cascade definition fails closed");
    checked(sql("ALTER TABLE public.messages DROP CONSTRAINT messages_session_id_chat_sessions_id_fk; ALTER TABLE public.messages ADD CONSTRAINT messages_session_id_chat_sessions_id_fk FOREIGN KEY (session_id) REFERENCES public.chat_sessions(id) ON DELETE CASCADE"), "restore message cascade");
    checked(sql("ALTER TABLE public.providers DROP CONSTRAINT providers_kind_check; ALTER TABLE public.providers ADD CONSTRAINT providers_kind_check CHECK (kind in ('meta','openai-compatible','custom'))"), "weaken provider kind fixture");
    assert.notEqual(provision().status, 0, "weakened provider kind definition fails closed");
    checked(sql("ALTER TABLE public.providers DROP CONSTRAINT providers_kind_check; ALTER TABLE public.providers ADD CONSTRAINT providers_kind_check CHECK (kind in ('meta','openai-compatible'))"), "restore provider kind check");
    checked(sql("ALTER TABLE public.model_roles DROP CONSTRAINT model_roles_mode_check; ALTER TABLE public.model_roles ADD CONSTRAINT model_roles_mode_check CHECK (mode in ('active','off','meta','weekly'))"), "weaken model role mode fixture");
    assert.notEqual(provision().status, 0, "weakened model role mode definition fails closed");
    checked(sql("ALTER TABLE public.model_roles DROP CONSTRAINT model_roles_mode_check; ALTER TABLE public.model_roles ADD CONSTRAINT model_roles_mode_check CHECK (mode in ('active','off','meta'))"), "restore model role mode check");
    checked(sql("ALTER TABLE public.model_roles DROP CONSTRAINT model_roles_role_check; ALTER TABLE public.model_roles ADD CONSTRAINT model_roles_role_check CHECK (role in ('main','sam') AND role <> '')"), "alter model role check fixture");
    assert.notEqual(provision().status, 0, "altered model role definition fails preflight despite matching old substrings");
    checked(sql("ALTER TABLE public.model_roles DROP CONSTRAINT model_roles_role_check; ALTER TABLE public.model_roles ADD CONSTRAINT model_roles_role_check CHECK (role in ('main','sam','background'))"), "restore model role check");
    checked(sql("ALTER TABLE public.model_roles DROP CONSTRAINT model_roles_main_shape_check; ALTER TABLE public.model_roles ADD CONSTRAINT model_roles_main_shape_check CHECK (role <> 'main' OR (mode = 'active' AND provider_id IS NOT NULL AND model IS NOT NULL AND use_main_key = false AND model <> ''))"), "alter main role shape fixture");
    assert.notEqual(provision().status, 0, "altered main role shape fails preflight despite matching old substrings");
    checked(sql("ALTER TABLE public.model_roles DROP CONSTRAINT model_roles_main_shape_check; ALTER TABLE public.model_roles ADD CONSTRAINT model_roles_main_shape_check CHECK (role <> 'main' OR (mode = 'active' AND provider_id IS NOT NULL AND model IS NOT NULL AND use_main_key = false))"), "restore main role shape check");
    checked(sql("ALTER TABLE public.model_roles DROP CONSTRAINT model_roles_sam_shape_check; ALTER TABLE public.model_roles ADD CONSTRAINT model_roles_sam_shape_check CHECK (role <> 'sam' OR ((mode = 'off' AND provider_id IS NULL AND model IS NULL AND use_main_key = false) OR (mode = 'meta' AND provider_id IS NOT NULL AND model IS NOT NULL AND model <> '')))"), "alter SAM role shape fixture");
    assert.notEqual(provision().status, 0, "altered SAM role shape fails preflight despite matching old substrings");
    checked(sql("ALTER TABLE public.model_roles DROP CONSTRAINT model_roles_sam_shape_check; ALTER TABLE public.model_roles ADD CONSTRAINT model_roles_sam_shape_check CHECK (role <> 'sam' OR ((mode = 'off' AND provider_id IS NULL AND model IS NULL AND use_main_key = false) OR (mode = 'meta' AND provider_id IS NOT NULL AND model IS NOT NULL)))"), "restore SAM role shape check");
    checked(sql("ALTER TABLE public.model_roles DROP CONSTRAINT model_roles_provider_id_providers_id_fk; ALTER TABLE public.model_roles ADD CONSTRAINT model_roles_provider_id_providers_id_fk FOREIGN KEY (provider_id) REFERENCES public.providers(id) ON DELETE RESTRICT ON UPDATE CASCADE"), "alter model role provider FK fixture");
    assert.notEqual(provision().status, 0, "altered model role provider FK fails preflight despite matching old substring");
    checked(sql("ALTER TABLE public.model_roles DROP CONSTRAINT model_roles_provider_id_providers_id_fk; ALTER TABLE public.model_roles ADD CONSTRAINT model_roles_provider_id_providers_id_fk FOREIGN KEY (provider_id) REFERENCES public.providers(id) ON DELETE RESTRICT"), "restore model role provider FK");
    checked(provision(), "provision restored agent and model constraint definitions");
    assert.equal(checked(sql("SELECT count(*) FROM pg_roles WHERE rolname IN ('eclipse_app','eclipse_migrator') AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls"), "check role attributes"), "2");
    assert.equal(checked(sql("SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname IN ('eclipse_app','eclipse_migrator')"), "check role memberships"), "0");
    const concurrentInsert = (suffix) => new Promise((resolve) => {
      const query = `INSERT INTO public.owner(id,owner_id,login,password_hash,timezone) VALUES ('00000000-0000-0000-0000-00000000000${suffix}','00000000-0000-0000-0000-00000000000${suffix}','owner${suffix}','hash','UTC')`;
      const child = spawn("docker", ["exec", "--env", "PGPASSWORD", container, "psql", "-h", "127.0.0.1", "-U", "eclipse_app", "-d", "eclipse", "-v", "ON_ERROR_STOP=1", "-Atc", query], { env: { ...env, PGPASSWORD: appPassword }, stdio: "ignore" });
      child.on("close", (status) => resolve(status));
      child.on("error", () => resolve(-1));
    });
    const inserts = await Promise.all([concurrentInsert(1), concurrentInsert(2)]);
    assert.equal(inserts.filter((status) => status === 0).length, 2, "concurrent owner inserts with distinct logins both succeed");
    assert.equal(checked(sql("SELECT count(*) FROM public.owner"), "multi-account invariant"), "2");
    // The rest of this test exercises the runtime as one account: drop the second synthetic owner again.
    checked(sql("DELETE FROM public.owner WHERE id='00000000-0000-0000-0000-000000000002'"), "restore single synthetic owner");
    checked(sql("UPDATE public.owner SET login = 'owner' WHERE id='00000000-0000-0000-0000-000000000001'", "eclipse_app"), "normalize synthetic login");
    checked(sql("UPDATE public.owner SET timezone = 'Asia/Kolkata'", "eclipse_app"), "runtime update");
    assert.equal(checked(sql("SELECT login FROM public.owner", "eclipse_app"), "runtime select"), "owner");
    checked(sql("INSERT INTO public.sessions(id,owner_id,token_hash,csrf_token,expires_at) SELECT '00000000-0000-0000-0000-000000000010',id,'synthetic-token-hash','synthetic-csrf',now() + interval '1 hour' FROM public.owner", "eclipse_app"), "create synthetic session");
    checked(sql("INSERT INTO public.agents(id,owner_id,name,role,soul_md,status,daily_budget_cents,monthly_budget_cents) SELECT '00000000-0000-0000-0000-000000000020',id,'synthetic','role','soul','paused',100,1000 FROM public.owner", "eclipse_app"), "create synthetic agent");
    checked(sql("INSERT INTO public.agent_policies(agent_id,owner_id,tools,domains,actions,memory_scopes) VALUES ('00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000001',ARRAY['tool'],ARRAY['example.com'],ARRAY['read'],ARRAY['agent'])", "eclipse_app"), "create synthetic agent policy");
    // TASK-047: the canary is config (planted_at is claimed once); security events are append-only.
    checked(sql("INSERT INTO public.agent_canaries(agent_id,owner_id,encrypted_canary,canary_sha256) VALUES ('00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000001','v1.synthetic',repeat('a',64))", "eclipse_app"), "runtime stores an encrypted canary");
    checked(sql("UPDATE public.agent_canaries SET planted_at = now()", "eclipse_app"), "runtime claims canary planting once");
    assert.notEqual(sql("DELETE FROM public.agent_canaries", "eclipse_app").status, 0, "runtime cannot delete canaries directly");
    checked(sql("INSERT INTO public.security_events(id,owner_id,agent_id,kind,source,source_ref) VALUES ('00000000-0000-0000-0000-000000000050','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000020','canary_leak','typed_text','typed_text:synthetic:1')", "eclipse_app"), "runtime appends a security event");
    assert.notEqual(sql("INSERT INTO public.security_events(id,owner_id,agent_id,kind,source,source_ref) VALUES ('00000000-0000-0000-0000-000000000051','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000020','other','typed_text','typed_text:synthetic:2')", "eclipse_app").status, 0, "unknown security event kind is refused");
    assert.notEqual(sql("UPDATE public.security_events SET source='proxy_host'", "eclipse_app").status, 0, "runtime cannot rewrite security events");
    assert.notEqual(sql("DELETE FROM public.security_events", "eclipse_app").status, 0, "runtime cannot delete security events");
    // TASK-052: the signed audit log is append-only for the runtime role.
    checked(sql("INSERT INTO public.audit_log(id,owner_id,seq,kind,entry_json,entry_hash,prev_hash,signature,key_id) VALUES ('00000000-0000-0000-0000-000000000090','00000000-0000-0000-0000-000000000001',1,'login','{}',repeat('a',64),repeat('b',64),'synthetic-signature','sha256:'||repeat('c',64))", "eclipse_app"), "runtime appends an audit entry");
    assert.notEqual(sql("INSERT INTO public.audit_log(id,owner_id,seq,kind,entry_json,entry_hash,prev_hash,signature,key_id) VALUES ('00000000-0000-0000-0000-000000000091','00000000-0000-0000-0000-000000000001',2,'unknown','{}',repeat('a',64),repeat('b',64),'s','sha256:'||repeat('c',64))", "eclipse_app").status, 0, "unknown audit kind is refused");
    assert.notEqual(sql("UPDATE public.audit_log SET kind='login'", "eclipse_app").status, 0, "runtime cannot rewrite audit entries");
    assert.notEqual(sql("DELETE FROM public.audit_log", "eclipse_app").status, 0, "runtime cannot delete audit entries");
    // TASK-053/054: memory entry state is editable, the version log is append-only, requests are decided once.
    checked(sql("INSERT INTO public.memory_entries(id,owner_id,doc,scope,title,body,author) VALUES ('00000000-0000-0000-0000-000000000092','00000000-0000-0000-0000-000000000001','user','global','Timezone','IST','owner')", "eclipse_app"), "runtime adds a memory entry");
    checked(sql("UPDATE public.memory_entries SET body='IST (India)'", "eclipse_app"), "runtime edits a memory entry");
    assert.notEqual(sql("DELETE FROM public.memory_entries", "eclipse_app").status, 0, "runtime cannot delete memory entries");
    checked(sql("INSERT INTO public.memory_versions(id,owner_id,doc_key,seq,op,author) VALUES ('00000000-0000-0000-0000-000000000093','00000000-0000-0000-0000-000000000001','user',1,'add','owner')", "eclipse_app"), "runtime appends a memory version");
    assert.notEqual(sql("UPDATE public.memory_versions SET op='edit'", "eclipse_app").status, 0, "runtime cannot rewrite memory versions");
    checked(sql("INSERT INTO public.memory_changes(id,owner_id,agent_id,doc,scope,title,body,reason) VALUES ('00000000-0000-0000-0000-000000000094','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000020','memory','agent','Fact','Body','Why')", "eclipse_app"), "runtime proposes a memory change");
    checked(sql("UPDATE public.memory_changes SET state='approved'", "eclipse_app"), "runtime decides a memory change once");
    assert.notEqual(sql("DELETE FROM public.memory_changes", "eclipse_app").status, 0, "runtime cannot delete memory changes");
    // TASK-070: connections are owner-managed, and the token ciphertext is the only secret in the row.
    checked(sql(`INSERT INTO public.connections(id,owner_id,agent_id,preset,label,bindings,encrypted_token,token_hint) VALUES ('00000000-0000-0000-0000-000000000095','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000020','github','Work','[{"host":"api.github.com","scheme":"bearer"}]'::jsonb,'v1.synthetic','••••test')`, "eclipse_app"), "runtime adds a connection");
    checked(sql("UPDATE public.connections SET label='Work 2'", "eclipse_app"), "runtime relabels a connection");
    // TASK-072: a pinned MCP server references an owner-managed connection and is owner-managed itself.
    checked(sql(`INSERT INTO public.mcp_servers(id,owner_id,agent_id,key,preset,url,connection_id,server_name,server_version,protocol_version,tools_hash,tools) VALUES ('00000000-0000-0000-0000-000000000097','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000020','github','github','https://api.githubcopilot.com/mcp/','00000000-0000-0000-0000-000000000095','Fake','1','2025-06-18',repeat('a',64),'[]'::jsonb)`, "eclipse_app"), "runtime pins an MCP server");
    checked(sql("UPDATE public.mcp_servers SET status='changed'", "eclipse_app"), "runtime marks a changed pin");
    assert.notEqual(sql(`INSERT INTO public.mcp_servers(id,owner_id,agent_id,key,preset,url,connection_id,server_name,server_version,protocol_version,tools_hash,tools) VALUES ('00000000-0000-0000-0000-000000000098','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000020','bad','gitlab','https://api.githubcopilot.com/mcp/','00000000-0000-0000-0000-000000000095','Fake','1','2025-06-18',repeat('b',64),'[]'::jsonb)`, "eclipse_app").status, 0, "unknown MCP preset is refused");
    checked(sql("DELETE FROM public.mcp_servers WHERE id='00000000-0000-0000-0000-000000000097'", "eclipse_app"), "runtime removes an MCP server");
    // TASK-075: the owner-level Composio key and per-agent connected accounts.
    checked(sql("INSERT INTO public.composio_keys(id,owner_id,encrypted_key,key_hint) VALUES ('00000000-0000-0000-0000-000000000099','00000000-0000-0000-0000-000000000001','v1.synthetic','••••test')", "eclipse_app"), "runtime saves a Composio key");
    checked(sql("UPDATE public.composio_keys SET injection_check = true", "eclipse_app"), "runtime toggles the injection check");
    checked(sql("INSERT INTO public.composio_accounts(id,owner_id,agent_id,toolkit) VALUES ('00000000-0000-0000-0000-00000000009a','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000020','gmail')", "eclipse_app"), "runtime adds a Composio account");
    checked(sql("UPDATE public.composio_accounts SET status='active'", "eclipse_app"), "runtime activates a Composio account");
    assert.notEqual(sql(`INSERT INTO public.composio_accounts(id,owner_id,agent_id,toolkit) VALUES ('00000000-0000-0000-0000-00000000009b','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000020','Bad Toolkit')`, "eclipse_app").status, 0, "invalid Composio toolkit is refused");
    checked(sql("DELETE FROM public.composio_accounts WHERE id='00000000-0000-0000-0000-00000000009a'", "eclipse_app"), "runtime removes a Composio account");
    checked(sql("DELETE FROM public.composio_keys", "eclipse_app"), "runtime removes the Composio key");
    assert.notEqual(sql(`INSERT INTO public.connections(id,owner_id,agent_id,preset,label,bindings,encrypted_token,token_hint) VALUES ('00000000-0000-0000-0000-000000000096','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000020','gitlab','Bad','[]'::jsonb,'v1.synthetic','••••test')`, "eclipse_app").status, 0, "unknown preset is refused");
    checked(sql("DELETE FROM public.connections WHERE id='00000000-0000-0000-0000-000000000095'", "eclipse_app"), "runtime removes a connection");
    assert.notEqual(sql("UPDATE public.agents SET attention_reason='unknown'", "eclipse_app").status, 0, "unknown attention reason is refused");
    checked(sql("UPDATE public.agents SET attention_reason='budget_warning'", "eclipse_app"), "runtime stores budget attention");
    checked(sql("UPDATE public.agents SET attention_reason='security_stop'", "eclipse_app"), "runtime stores security attention");
    assert.equal(checked(sql("SELECT count(*) FROM public.agent_policies", "eclipse_app"), "runtime reads agent policies"), "1");
    checked(sql("INSERT INTO public.chat_sessions(id,owner_id,agent_id) VALUES ('00000000-0000-0000-0000-000000000030','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000020')", "eclipse_app"), "create synthetic chat session");
    checked(sql("INSERT INTO public.messages(id,owner_id,session_id,role,card_type,content,source_tag) VALUES ('00000000-0000-0000-0000-000000000031','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000030','user','message','{\"type\":\"message\",\"text\":\"Synthetic\"}'::jsonb,'user')", "eclipse_app"), "create synthetic chat message");
    assert.equal(checked(sql("SELECT count(*) FROM public.messages", "eclipse_app"), "runtime reads chat messages"), "1");
    checked(sql("INSERT INTO public.providers(id,owner_id,kind,encrypted_key,key_hint) VALUES ('00000000-0000-0000-0000-000000000040','00000000-0000-0000-0000-000000000001','meta','v1.synthetic',repeat(chr(8226),4)||'test')", "eclipse_app"), "create synthetic provider");
    checked(sql("INSERT INTO public.model_roles(id,owner_id,role,provider_id,model,use_main_key,mode) VALUES ('00000000-0000-0000-0000-000000000041','00000000-0000-0000-0000-000000000001','main','00000000-0000-0000-0000-000000000040','muse-spark-1.3',false,'active')", "eclipse_app"), "create synthetic main role");
    assert.equal(checked(sql("SELECT (SELECT count(*) FROM public.providers), (SELECT count(*) FROM public.model_roles)", "eclipse_app"), "runtime reads model settings"), "1|1");
    assert.notEqual(sql("INSERT INTO public.model_roles(id,owner_id,role,provider_id,model,mode) VALUES ('00000000-0000-0000-0000-000000000042','00000000-0000-0000-0000-000000000001','main','00000000-0000-0000-0000-000000000040','duplicate','off')", "eclipse_app").status, 0, "one role per owner");
    assert.notEqual(sql("DELETE FROM public.model_roles", "eclipse_app").status, 0, "runtime cannot delete model roles");
    checked(sql("INSERT INTO public.providers(id,owner_id,kind) VALUES ('00000000-0000-0000-0000-000000000043','00000000-0000-0000-0000-000000000001','meta')", "eclipse_app"), "create unused provider");
    checked(sql("DELETE FROM public.providers WHERE id='00000000-0000-0000-0000-000000000043'", "eclipse_app"), "runtime removes unused provider");
    assert.notEqual(sql("DELETE FROM public.providers WHERE id='00000000-0000-0000-0000-000000000040'", "eclipse_app").status, 0, "provider in use is protected");
    assert.notEqual(sql("UPDATE public.messages SET source_tag='agent'", "eclipse_app").status, 0, "runtime cannot rewrite messages");
    assert.notEqual(sql("DELETE FROM public.chat_sessions", "eclipse_app").status, 0, "runtime cannot delete chat sessions directly");
    assert.notEqual(sql("DELETE FROM public.agent_policies", "eclipse_app").status, 0, "runtime cannot delete policies directly");
    checked(sql("DELETE FROM public.agents WHERE id='00000000-0000-0000-0000-000000000020'", "eclipse_app"), "runtime deletes owned agent and cascades policy and chat");
    assert.equal(checked(sql("SELECT count(*) FROM public.agent_policies", "eclipse_app"), "agent policy cascade"), "0");
    assert.equal(checked(sql("SELECT count(*) FROM public.agent_canaries", "eclipse_app"), "canary cascade"), "0");
    assert.equal(checked(sql("SELECT count(*) FROM public.security_events", "eclipse_app"), "security events survive agent deletion"), "1");
    assert.equal(checked(sql("SELECT (SELECT count(*) FROM public.chat_sessions), (SELECT count(*) FROM public.messages)", "eclipse_app"), "chat cascade"), "0|0");
    // TASK-029 receipts: the runtime inserts and reads steps, seals a run once, and can never rewrite or delete proof.
    const runId = "00000000-0000-0000-0000-000000000050";
    const ownerId = "00000000-0000-0000-0000-000000000001";
    checked(sql(`INSERT INTO public.runs(id,owner_id,agent_id,header_json,header_hash,key_id,public_key,started_at) VALUES ('${runId}','${ownerId}','00000000-0000-0000-0000-000000000020','{}',repeat('a',64),'sha256:'||repeat('b',64),'k',now())`, "eclipse_app"), "runtime starts a run (agent row is gone: no foreign key)");
    checked(sql(`INSERT INTO public.steps(id,owner_id,run_id,idx,receipt_json,receipt_hash,prev_hash) VALUES ('00000000-0000-0000-0000-000000000051','${ownerId}','${runId}',1,'{}',repeat('c',64),repeat('a',64))`, "eclipse_app"), "runtime appends a receipt");
    assert.notEqual(sql(`INSERT INTO public.steps(id,owner_id,run_id,idx,receipt_json,receipt_hash,prev_hash) VALUES ('00000000-0000-0000-0000-000000000052','${ownerId}','${runId}',1,'{}',repeat('d',64),repeat('c',64))`, "eclipse_app").status, 0, "a step index cannot repeat in a run");
    assert.notEqual(sql("UPDATE public.steps SET receipt_json = '{\"x\":1}'", "eclipse_app").status, 0, "runtime cannot rewrite receipts");
    assert.notEqual(sql("DELETE FROM public.steps", "eclipse_app").status, 0, "runtime cannot delete receipts");
    assert.notEqual(sql("DELETE FROM public.runs", "eclipse_app").status, 0, "runtime cannot delete runs");
    assert.notEqual(sql(`UPDATE public.runs SET signature = 's' WHERE id = '${runId}'`, "eclipse_app").status, 0, "a half-set seal is refused by the check");
    checked(sql(`UPDATE public.runs SET status='finished', ended_at=now(), step_count=1, head_hash=repeat('c',64), usage='{}'::jsonb, signature='s' WHERE id='${runId}' AND signature IS NULL`, "eclipse_app"), "runtime seals a run once");
    checked(sql(`UPDATE public.runs SET status='x' WHERE id='${runId}' AND signature IS NULL`, "eclipse_app"), "second seal attempt matches nothing");
    assert.equal(checked(sql(`SELECT status FROM public.runs WHERE id='${runId}'`, "eclipse_app"), "seal stays as first written"), "finished");
    assert.equal(checked(sql("SELECT (SELECT count(*) FROM public.runs), (SELECT count(*) FROM public.steps)", "eclipse_app"), "runtime reads proof"), "1|1");
    checked(provision(), "provisioning with populated receipts");
    checked(sql("ALTER TABLE public.steps ADD COLUMN unexpected text"), "unknown steps schema fixture");
    assert.notEqual(provision().status, 0, "unknown steps columns fail closed");
    checked(sql("ALTER TABLE public.steps DROP COLUMN unexpected"), "restore steps schema");
    checked(sql("GRANT UPDATE ON public.steps TO eclipse_app"), "widen steps grant fixture");
    assert.notEqual(provision().status, 0, "extra steps privilege fails preflight");
    checked(sql("REVOKE UPDATE ON public.steps FROM eclipse_app"), "restore steps grant");
    // TASK-031 step evidence: display data next to a receipt. The runtime may add and read it, never rewrite or delete it.
    checked(sql(`INSERT INTO public.step_evidence(id,owner_id,run_id,idx,before_hash,after_hash,width,height,sam_box) VALUES ('00000000-0000-0000-0000-000000000053','${ownerId}','${runId}',1,repeat('e',64),repeat('f',64),1024,768,'{"x1":1,"y1":2,"x2":3,"y2":4}'::jsonb)`, "eclipse_app"), "runtime stores step evidence");
    assert.notEqual(sql(`INSERT INTO public.step_evidence(id,owner_id,run_id,idx) VALUES ('00000000-0000-0000-0000-000000000054','${ownerId}','${runId}',1)`, "eclipse_app").status, 0, "evidence cannot repeat for a step");
    assert.notEqual(sql("UPDATE public.step_evidence SET sam_box = NULL", "eclipse_app").status, 0, "runtime cannot rewrite evidence");
    assert.notEqual(sql("DELETE FROM public.step_evidence", "eclipse_app").status, 0, "runtime cannot delete evidence");
    assert.equal(checked(sql("SELECT count(*) FROM public.step_evidence", "eclipse_app"), "runtime reads evidence"), "1");
    checked(provision(), "provisioning with populated evidence");
    checked(sql("ALTER TABLE public.step_evidence ADD COLUMN unexpected text"), "unknown evidence schema fixture");
    assert.notEqual(provision().status, 0, "unknown evidence columns fail closed");
    checked(sql("ALTER TABLE public.step_evidence DROP COLUMN unexpected"), "restore evidence schema");
    checked(sql("GRANT UPDATE ON public.step_evidence TO eclipse_app"), "widen evidence grant fixture");
    assert.notEqual(provision().status, 0, "extra evidence privilege fails preflight");
    checked(sql("REVOKE UPDATE ON public.step_evidence FROM eclipse_app"), "restore evidence grant");
    // TASK-032 checkpoints: pointers to stored state. The runtime may add and read them, never rewrite or delete them.
    checked(sql(`INSERT INTO public.checkpoints(id,owner_id,run_id,idx,state_hash,manifest_hash,file_count,restorable_count,status) VALUES ('00000000-0000-0000-0000-000000000055','${ownerId}','${runId}',0,repeat('a',64),repeat('b',64),2,1,'complete')`, "eclipse_app"), "runtime stores a checkpoint");
    checked(sql(`INSERT INTO public.checkpoints(id,owner_id,run_id,idx,state_hash,status,reason) VALUES ('00000000-0000-0000-0000-000000000056','${ownerId}','${runId}',1,repeat('a',64),'partial','files_unreadable')`, "eclipse_app"), "runtime stores a partial checkpoint with no manifest");
    assert.notEqual(sql(`INSERT INTO public.checkpoints(id,owner_id,run_id,idx,state_hash,status) VALUES ('00000000-0000-0000-0000-000000000057','${ownerId}','${runId}',1,repeat('a',64),'complete')`, "eclipse_app").status, 0, "a checkpoint index cannot repeat in a run");
    assert.notEqual(sql(`INSERT INTO public.checkpoints(id,owner_id,run_id,idx,state_hash,status) VALUES ('00000000-0000-0000-0000-000000000058','${ownerId}','${runId}',2,repeat('a',64),'bogus')`, "eclipse_app").status, 0, "status is limited to complete or partial");
    assert.notEqual(sql("UPDATE public.checkpoints SET status = 'complete'", "eclipse_app").status, 0, "runtime cannot rewrite checkpoints");
    assert.notEqual(sql("DELETE FROM public.checkpoints", "eclipse_app").status, 0, "runtime cannot delete checkpoints");
    assert.equal(checked(sql("SELECT count(*) FROM public.checkpoints", "eclipse_app"), "runtime reads checkpoints"), "2");
    checked(provision(), "provisioning with populated checkpoints");
    checked(sql("ALTER TABLE public.checkpoints ADD COLUMN unexpected text"), "unknown checkpoints schema fixture");
    assert.notEqual(provision().status, 0, "unknown checkpoints columns fail closed");
    checked(sql("ALTER TABLE public.checkpoints DROP COLUMN unexpected"), "restore checkpoints schema");
    checked(sql("GRANT UPDATE ON public.checkpoints TO eclipse_app"), "widen checkpoints grant fixture");
    assert.notEqual(provision().status, 0, "extra checkpoints privilege fails preflight");
    checked(sql("REVOKE UPDATE ON public.checkpoints FROM eclipse_app"), "restore checkpoints grant");
    // TASK-034 prices are owner-editable; spend rows are append-only and idempotent per model call.
    checked(sql(`INSERT INTO public.model_prices(id,owner_id,provider_id,model,input_micro_usd_per_million,cached_micro_usd_per_million,output_micro_usd_per_million,image_micro_usd_per_thousand) VALUES ('00000000-0000-0000-0000-000000000060','${ownerId}','00000000-0000-0000-0000-000000000040','muse-spark-1.3',1250000,150000,4250000,0)`, "eclipse_app"), "runtime saves a model price");
    checked(sql("UPDATE public.model_prices SET output_micro_usd_per_million = 4250001", "eclipse_app"), "runtime edits a model price");
    assert.equal(checked(sql("SELECT input_micro_usd_per_million FROM public.model_prices", "eclipse_app"), "runtime reads prices"), "1250000");
    checked(sql(`INSERT INTO public.cost_entries(id,owner_id,run_id,agent_id,provider_id,call_index,model,tokens_in,tokens_out,tokens_cached,cost_micro_usd,outcome,idempotency_key) VALUES ('00000000-0000-0000-0000-000000000061','${ownerId}','${runId}','00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000040',1,'muse-spark-1.3',1000,100,200,1234,'completed','cost:${runId}:1')`, "eclipse_app"), "runtime appends a cost row");
    assert.notEqual(sql(`INSERT INTO public.cost_entries(id,owner_id,run_id,agent_id,provider_id,call_index,model,tokens_in,tokens_out,tokens_cached,cost_micro_usd,outcome,idempotency_key) VALUES ('00000000-0000-0000-0000-000000000062','${ownerId}','${runId}','00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000040',1,'muse-spark-1.3',1,0,0,1,'completed','cost:${runId}:1')`, "eclipse_app").status, 0, "a model-call cost key cannot repeat");
    assert.notEqual(sql("UPDATE public.cost_entries SET cost_micro_usd = 0", "eclipse_app").status, 0, "runtime cannot rewrite spend");
    assert.notEqual(sql("DELETE FROM public.cost_entries", "eclipse_app").status, 0, "runtime cannot delete spend");
    assert.notEqual(sql("DELETE FROM public.model_prices", "eclipse_app").status, 0, "runtime cannot delete price history through the ledger grant");
    checked(provision(), "provisioning with populated prices and spend");
    checked(sql("ALTER TABLE public.cost_entries ADD COLUMN unexpected text"), "unknown cost schema fixture");
    assert.notEqual(provision().status, 0, "unknown cost columns fail closed");
    checked(sql("ALTER TABLE public.cost_entries DROP COLUMN unexpected"), "restore cost schema");
    checked(sql("GRANT UPDATE ON public.cost_entries TO eclipse_app"), "widen cost grant fixture");
    assert.notEqual(provision().status, 0, "spend update privilege fails preflight");
    checked(sql("REVOKE UPDATE ON public.cost_entries FROM eclipse_app"), "restore cost grant");
    // TASK-036 extends only the known audio/teach shape and keeps the ledger append-only.
    const captureId = "00000000-0000-0000-0000-000000000070";
    checked(sql("INSERT INTO public.teach_recordings(id,owner_id,agent_id,generation,state,timezone,narration) VALUES ('" + captureId + "','" + ownerId + "','00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000071','complete','UTC',true)", "eclipse_app"), "runtime inserts teach capture");
    checked(sql("UPDATE public.teach_recordings SET narration_status='complete' WHERE id='" + captureId + "'", "eclipse_app"), "runtime updates teach capture");
    assert.notEqual(sql("DELETE FROM public.teach_recordings", "eclipse_app").status, 0, "runtime cannot delete teach attribution rows");
    const audioInsert = "INSERT INTO public.cost_entries(id,owner_id,capture_id,agent_id,provider_id,call_index,model,tokens_in,tokens_out,tokens_cached,cost_micro_usd,outcome,idempotency_key,audio_duration_ms) VALUES ('00000000-0000-0000-0000-000000000072','" + ownerId + "','" + captureId + "','00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000040',1,'muse-voice-transcribe-1.0',0,0,0,50,'asr_complete','teach:" + captureId + ":asr:0',1000)";
    checked(sql(audioInsert, "eclipse_app"), "runtime appends audio cost without fake run");
    assert.notEqual(sql(audioInsert, "eclipse_app").status, 0, "audio segment cost cannot repeat");
    assert.notEqual(sql(audioInsert.replace("00000000-0000-0000-0000-000000000072", "00000000-0000-0000-0000-000000000073").replace("capture_id,agent_id", "capture_id,run_id,agent_id").replace("'" + captureId + "','00000000", "'" + captureId + "','" + runId + "','00000000"), "eclipse_app").status, 0, "both run and capture attribution are denied");
    checked(sql("UPDATE public.model_prices SET audio_micro_usd_per_hour=180000", "eclipse_app"), "runtime saves audio hourly override");
    assert.notEqual(sql("UPDATE public.model_prices SET audio_micro_usd_per_hour=-1", "eclipse_app").status, 0, "negative audio rate is denied");
    checked(provision(), "provision populated teach/audio schema");
    for (const [mutate, restore, description] of [
      ["ALTER TABLE public.teach_recordings ADD COLUMN unexpected text", "ALTER TABLE public.teach_recordings DROP COLUMN unexpected", "unknown teach column"],
      ["ALTER TABLE public.teach_recordings ALTER COLUMN narration_status SET DEFAULT 'pending'", "ALTER TABLE public.teach_recordings ALTER COLUMN narration_status SET DEFAULT 'off'", "changed teach default"],
      ["ALTER TABLE public.teach_recordings ALTER COLUMN narration DROP NOT NULL", "ALTER TABLE public.teach_recordings ALTER COLUMN narration SET NOT NULL", "nullable teach flag"],
      ["DROP INDEX public.teach_recordings_agent_id_idx; CREATE INDEX teach_recordings_agent_id_idx ON public.teach_recordings(owner_id)", "DROP INDEX public.teach_recordings_agent_id_idx; CREATE INDEX teach_recordings_agent_id_idx ON public.teach_recordings(agent_id)", "wrong known-name teach index"],
      ["GRANT DELETE ON public.teach_recordings TO eclipse_app", "REVOKE DELETE ON public.teach_recordings FROM eclipse_app", "widened teach delete grant"],
      ["ALTER TABLE public.model_prices ALTER COLUMN audio_micro_usd_per_hour SET DEFAULT 1", "ALTER TABLE public.model_prices ALTER COLUMN audio_micro_usd_per_hour SET DEFAULT 0", "changed audio rate default"],
    ]) {
      checked(sql(mutate), description + " fixture");
      try { assert.notEqual(provision().status, 0, description + " fails closed"); }
      finally { checked(sql(restore), "restore " + description); }
    }
    // Restores use the original migration DDL (BETWEEN form), not a pg_get_constraintdef
    // round-trip: re-parsing the deparsed text left-flattens the first AND pair
    // (e.g. rates/bounds checks), which is semantically identical but textually
    // different from the migrated catalog form that provisioning pins.
    for (const [table, constraint, weak, restore] of [
      ["teach_recordings", "teach_recordings_bounds_check", "active_ms >= 0", "active_ms between 0 and 120000 and event_count between 0 and 300"],
      ["cost_entries", "cost_entries_source_check", "run_id IS NOT NULL OR capture_id IS NOT NULL", "(run_id is not null)::integer + (capture_id is not null)::integer + (background_job_id is not null)::integer = 1"],
      ["cost_entries", "cost_entries_audio_duration_check", "audio_duration_ms >= 0", "audio_duration_ms between 0 and 120000"],
      ["model_prices", "model_prices_rates_check", "audio_micro_usd_per_hour >= 0", "input_micro_usd_per_million between 0 and 1000000000 and cached_micro_usd_per_million between 0 and 1000000000 and output_micro_usd_per_million between 0 and 1000000000 and image_micro_usd_per_thousand between 0 and 1000000000 and audio_micro_usd_per_hour between 0 and 1000000000"],
    ]) {
      checked(sql("ALTER TABLE public." + table + " DROP CONSTRAINT " + constraint + "; ALTER TABLE public." + table + " ADD CONSTRAINT " + constraint + " CHECK (" + weak + ")"), "weaken " + constraint);
      try { assert.notEqual(provision().status, 0, constraint + " definition fails closed"); }
      finally { checked(sql("ALTER TABLE public." + table + " DROP CONSTRAINT " + constraint + "; ALTER TABLE public." + table + " ADD CONSTRAINT " + constraint + " CHECK (" + restore + ")"), "restore " + constraint); }
    }
    checked(provision(), "restored exact teach/audio contracts");
    checked(sql("TRUNCATE public.cost_entries, public.model_prices, public.step_evidence, public.steps, public.runs CASCADE"), "clear synthetic receipts, prices and spend");
    checked(provision(), "populated sessions and multi-account provisioning");
    assert.equal(checked(sql("SELECT count(*) FROM public.sessions"), "preserve sessions"), "1");
    checked(sql("ALTER TABLE public.sessions ADD COLUMN unexpected text"), "unknown sessions schema fixture");
    assert.notEqual(provision().status, 0, "unknown sessions columns fail closed");
    checked(sql("ALTER TABLE public.sessions DROP COLUMN unexpected"), "restore supported sessions schema");
    checked(sql("DROP INDEX public.sessions_owner_id_idx; CREATE INDEX sessions_owner_id_idx ON public.sessions(expires_at)"), "wrong known-name index fixture");
    assert.notEqual(provision().status, 0, "wrong known-name index fails closed");
    checked(sql("DROP INDEX public.sessions_owner_id_idx; CREATE INDEX sessions_owner_id_idx ON public.sessions(owner_id)"), "restore supported index");
    const resetPassword = "SYNTHETIC reset fixture 2026";
    const reset = () => spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/reset-password.mjs", "--login", "owner"], { env, input: `${resetPassword}\n`, encoding: "utf8", timeout: 120000 });
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
    assert.equal(checked(sql("SELECT count(*) FROM drizzle.__drizzle_migrations"), "preserve history"), EXPECTED_MIGRATIONS);
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
    // Every fail-closed fixture above makes Postgres log the whole provisioning statement, so the logs outgrow spawnSync's 1 MiB default.
    checked(docker(["compose", "logs", "--no-color"], { maxBuffer: 128 * 1024 * 1024 }), "check service logs");
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
    assert.equal(checked(result, "verify legacy data and ownership"), `1|${EXPECTED_MIGRATIONS}|eclipse_migrator`);
    assert.equal(checked(docker(["exec", container, "psql", "-U", "eclipse_bootstrap", "-d", "eclipse", "-Atc", "SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at=1793293249789"]), "verify original history is unchanged"), hash);
    assert.equal(checked(docker(["exec", container, "psql", "-U", "eclipse_bootstrap", "-d", "eclipse", "-Atc", "SELECT count(*) FROM public.sessions"]), "verify legacy sessions are preserved"), depth === 2 ? "1" : "0");
  } finally { cleanup(); }
});
}
}

test("known pre-0013 full schema provisions and upgrades without widening contracts", { timeout: 900000 }, () => {
  try {
    checked(compose("up", "-d", "app"), "start pre-teach fixture");
    const container = checked(compose("ps", "-q", "postgres"), "find pre-teach postgres");
    const sql = (query) => docker(["exec", "-i", container, "psql", "-U", "eclipse_bootstrap", "-d", "eclipse", "-v", "ON_ERROR_STOP=1", "-At", "-f", "-"], { input: query });
    checked(sql("CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);"), "create known migration history");
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
    for (const entry of journal.entries.filter((item) => item.idx < 13)) {
      const source = readFileSync("drizzle/" + entry.tag + ".sql", "utf8").replace(/\r\n/g, "\n");
      checked(sql(source), "apply known " + entry.tag);
      checked(sql("INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES ('" + createHash("sha256").update(source).digest("hex") + "'," + entry.when + ")"), "record known " + entry.tag);
    }
    const provision = () => spawnSync(process.execPath, ["scripts/db-provision.mjs"], { env, encoding: "utf8", timeout: 60000 });
    checked(provision(), "provision exact pre-0013 model/cost shape");
    checked(provision(), "repeat exact pre-0013 provisioning");
    assert.equal(checked(sql("SELECT count(*) FROM drizzle.__drizzle_migrations"), "pre-teach history"), "13");
    checked(sql("ALTER TABLE public.cost_entries ALTER COLUMN run_id DROP NOT NULL"), "partial teach upgrade fixture");
    try { assert.notEqual(provision().status, 0, "partial upgrade fails strict old contract"); }
    finally { checked(sql("ALTER TABLE public.cost_entries ALTER COLUMN run_id SET NOT NULL"), "restore pre-teach cost contract"); }
    checked(spawnSync(process.execPath, ["scripts/db-migrate.mjs"], { env, encoding: "utf8", timeout: 120000 }), "upgrade pre-teach schema");
    checked(provision(), "provision upgraded teach/audio schema");
    assert.equal(checked(sql("SELECT count(*) FROM drizzle.__drizzle_migrations"), "upgraded history"), EXPECTED_MIGRATIONS);
  } finally { cleanup(); }
});
