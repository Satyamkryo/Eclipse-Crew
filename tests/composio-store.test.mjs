import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const docker = (args) => spawnSync("docker", args, { encoding: "utf8", timeout: 120_000 });
const dockerUp = docker(["version", "--format", "{{.Server.Version}}"]).status === 0;
const name = `eclipse-composio-${randomBytes(6).toString("hex")}`;
const password = randomBytes(16).toString("hex");
const OWNER = randomUUID();
const AGENT = randomUUID();
const PEER = randomUUID();
let adminPool; let appPool; let database; let service; let data; let portModule;

const state = {
  bodies: [], deleted: false, revoke: true,
  tools: [
    { slug: "GMAIL_FETCH_EMAILS", name: "Fetch emails", description: "Read mail", input_parameters: { type: "object" }, tags: ["readOnlyHint"], version: "1" },
    { slug: "GMAIL_SEND_EMAIL", name: "Send email", description: "Send mail", input_parameters: { type: "object" }, tags: ["createHint"], version: "1" },
    { slug: "GMAIL_DELETE_MESSAGE", name: "Delete message", description: "Delete", tags: ["destructiveHint"], version: "1" },
  ],
  status: "ACTIVE",
  execute: null,
};

function fakeClient() {
  return {
    createSession: async (body) => { state.bodies.push(body); return "session-1"; },
    deleteSession: async () => {},
    listTools: async () => state.tools,
    toolkitStatus: async () => [{ slug: "gmail", status: state.status, accountId: "ca_1" }],
    createLink: async () => ({ connectedAccountId: "ca_1", redirectUrl: "https://platform.composio.dev/link/1" }),
    execute: async () => state.execute ?? { resultType: "completed", data: { messages: [] }, error: null, blockedHookId: null },
    deleteAccount: async () => { state.deleted = true; return state.revoke; },
  };
}
const factory = () => fakeClient();

test.before(async () => {
  if (!dockerUp) return;
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
  process.env.RECEIPT_SIGNING_KEY = randomBytes(32).toString("hex");
  delete process.env.EGRESS_PROXY_SECRET;
  const started = docker(["run", "-d", "--name", name, "-e", `POSTGRES_PASSWORD=${password}`, "-p", "127.0.0.1::5432",
    "postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b"]);
  assert.equal(started.status, 0, started.stderr);
  for (let i = 0; i < 40; i++) {
    if (docker(["exec", name, "pg_isready", "-U", "postgres", "-h", "127.0.0.1"]).status === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const port = Number(docker(["port", name, "5432/tcp"]).stdout.trim().split(":").pop());
  for (let i = 0; i < 40 && !adminPool; i++) {
    const candidate = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", password, database: "postgres" });
    try { await candidate.query("select 1"); adminPool = candidate; } catch { await candidate.end().catch(() => {}); await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
  assert.ok(adminPool, "database became reachable");
  for (const file of ["0000_solid_risque.sql", "0003_kind_jocasta.sql", "0023_audit_log.sql", "0026_tool_connections.sql", "0027_mcp_servers.sql", "0028_composio.sql"]) {
    const migration = readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8")
      .split("\n").filter((line) => !line.startsWith("--")).join("\n").replaceAll("--> statement-breakpoint", "");
    await adminPool.query(migration);
  }
  await adminPool.query(`CREATE ROLE app_role LOGIN PASSWORD '${password}';
    GRANT SELECT ON public.agents TO app_role;
    GRANT SELECT ON public.agent_policies TO app_role;
    GRANT SELECT ON public.connections TO app_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.composio_keys TO app_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.composio_accounts TO app_role;
    GRANT SELECT, INSERT ON public.audit_log TO app_role;`);
  await adminPool.query(`INSERT INTO public.owner(id,owner_id,login,password_hash,timezone) VALUES ($1,$1,'owner','hash','UTC')`, [OWNER]);
  for (const [id, label] of [[AGENT, "A"], [PEER, "B"]]) {
    await adminPool.query(`INSERT INTO public.agents(id,owner_id,name,role,soul_md,status,daily_budget_cents,monthly_budget_cents)
      VALUES ($1,$2,$3,'role','soul','active',100,1000)`, [id, OWNER, label]);
    await adminPool.query(`INSERT INTO public.agent_policies(agent_id,owner_id,tools,domains,actions,memory_scopes) VALUES ($1,$2,ARRAY['composio'],ARRAY[]::text[],ARRAY['tool_call'],ARRAY['agent'])`, [id, OWNER]);
  }
  appPool = new pg.Pool({ host: "127.0.0.1", port, user: "app_role", password, database: "postgres" });
  database = drizzle({ client: appPool });
  service = await import("../lib/composio/service.ts");
  data = await import("../lib/composio/data.ts");
  portModule = await import("../lib/tools/port.ts");
});
test.after(async () => {
  await appPool?.end().catch(() => {}); await adminPool?.end().catch(() => {});
  if (dockerUp) docker(["rm", "-f", name]);
});

const skip = !dockerUp && "Docker is not available";

test("the key is encrypted, masked and its settings can change without re-entering it", { skip }, async () => {
  const view = await service.saveComposioKey(database, OWNER, { apiKey: "composio_key_1234567890" });
  assert.equal(view.hasKey, true);
  assert.equal(view.keyHint.endsWith("7890"), true);
  assert.equal(view.injectionCheck, false);
  assert.equal(JSON.stringify(view).includes("composio_key_1234567890"), false);
  const toggled = await service.saveComposioKey(database, OWNER, { injectionCheck: true });
  assert.equal(toggled.injectionCheck, true);
  const stored = await data.getComposioKey(database, OWNER);
  assert.match(stored.encryptedKey, /^v1\./);
  const audit = await adminPool.query("select kind from audit_log where owner_id = $1", [OWNER]);
  assert.equal(audit.rows.some((row) => row.kind === "composio_key_saved"), true);
  assert.equal(audit.rows.some((row) => JSON.stringify(row).includes("composio_key_1234567890")), false);
});

test("connect, status, discovery, pin and a real tool call", { skip }, async () => {
  const connected = await service.connectComposioAccount(database, OWNER, { agentId: AGENT, toolkit: "gmail" }, factory);
  assert.equal(connected.redirectUrl, "https://platform.composio.dev/link/1");
  assert.equal(connected.account.status, "pending");
  await assert.rejects(() => service.connectComposioAccount(database, OWNER, { agentId: AGENT, toolkit: "gmail" }, factory),
    (error) => error.code === "already_connected");
  assert.equal(state.bodies[0].instant, false);
  assert.deepEqual(state.bodies[0].workbench, { enable: false });
  assert.deepEqual(state.bodies[0].toolkits.enable, ["gmail"]);

  const refreshed = await service.refreshComposioAccount(database, OWNER, connected.account.id, factory);
  assert.equal(refreshed.status, "active");

  const discovery = await service.discoverComposioTools(database, OWNER, connected.account.id, factory);
  assert.deepEqual(discovery.tools.map((tool) => tool.slug), ["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"]);
  const unpinned = await service.pinComposioAccount(database, OWNER, connected.account.id, {}, factory);
  assert.equal(unpinned.kind, "discovery");
  const pinned = await service.pinComposioAccount(database, OWNER, connected.account.id, { expectedToolsHash: discovery.toolsHash }, factory);
  assert.equal(pinned.kind, "pinned");
  assert.equal(pinned.account.status, "active");
  assert.equal(pinned.account.toolCount, 2);

  await data.updateComposioAccount(database, OWNER, pinned.account.id, { status: "changed" });
  assert.equal((await service.refreshComposioAccount(database, OWNER, pinned.account.id, factory)).status, "changed");
  await data.updateComposioAccount(database, OWNER, pinned.account.id, { status: "active" });
  state.status = "FAILED";
  assert.equal((await service.refreshComposioAccount(database, OWNER, pinned.account.id, factory)).status, "active");
  state.status = "ACTIVE";

  const port = portModule.createToolPort({ database, ownerId: OWNER, agentId: AGENT, composioFactory: factory });
  const tool = await port.prepare("composio.GMAIL_FETCH_EMAILS");
  assert.equal(tool.host, "backend.composio.dev/gmail");
  const result = await tool.invoke({ max_results: 5 });
  assert.equal(result.isError, false);
  assert.match(result.text, /messages/);
  await port.close();
});

test("a changed live tool list blocks calls until re-pinned", { skip }, async () => {
  const account = (await service.listComposioAccountViews(database, OWNER, AGENT))[0];
  state.tools = [{ ...state.tools[0], version: "2" }, ...state.tools.slice(1)];
  const port = portModule.createToolPort({ database, ownerId: OWNER, agentId: AGENT, composioFactory: factory });
  await assert.rejects(() => port.prepare("composio.GMAIL_FETCH_EMAILS"), (error) => error.code === "tools_changed");
  await port.close();
  const discovery = await service.discoverComposioTools(database, OWNER, account.id, factory);
  await service.pinComposioAccount(database, OWNER, account.id, { expectedToolsHash: discovery.toolsHash }, factory);
});

test("blocked and wrong-account calls fail closed", { skip }, async () => {
  state.execute = { resultType: "blocked", data: null, error: null, blockedHookId: "eclipse_injection_check" };
  const port = portModule.createToolPort({ database, ownerId: OWNER, agentId: AGENT, composioFactory: factory });
  const tool = await port.prepare("composio.GMAIL_FETCH_EMAILS");
  await assert.rejects(() => tool.invoke({}), (error) => error.code === "composio_injection_blocked");
  await port.close();
  state.execute = null;
  assert.equal((await service.listComposioAccountViews(database, OWNER, PEER)).length, 0);
  const account = (await service.listComposioAccountViews(database, OWNER, AGENT))[0];
  await assert.rejects(() => service.refreshComposioAccount(database, randomUUID(), account.id, factory), (error) => error.code === "not_found");
});

test("disconnect revokes at Composio and removing the key stops injection", { skip }, async () => {
  const [account] = await service.listComposioAccountViews(database, OWNER, AGENT);
  const revoked = await service.disconnectComposioAccount(database, OWNER, account.id, factory);
  assert.equal(revoked.account.status, "revoked");
  assert.equal(revoked.revoked, true);
  assert.equal(state.deleted, true);

  const auditsBeforeFailure = await adminPool.query(
    "select count(*)::int as count from audit_log where owner_id = $1 and kind = 'composio_account_revoked'", [OWNER],
  );
  state.revoke = false;
  const unconfirmed = await service.disconnectComposioAccount(database, OWNER, account.id, factory);
  assert.equal(unconfirmed.revoked, false);
  assert.equal(unconfirmed.account.status, "revoked");
  const auditsAfterFailure = await adminPool.query(
    "select count(*)::int as count from audit_log where owner_id = $1 and kind = 'composio_account_revoked'", [OWNER],
  );
  assert.equal(auditsAfterFailure.rows[0].count, auditsBeforeFailure.rows[0].count, "an unconfirmed remote revoke is not audited as success");
  await assert.rejects(() => service.refreshComposioAccount(database, OWNER, account.id, factory), (error) => error.code === "composio_not_connected");
  await assert.rejects(() => service.pinComposioAccount(database, OWNER, account.id, {}, factory), (error) => error.code === "composio_not_connected");

  state.revoke = true;
  const reconnected = await service.connectComposioAccount(database, OWNER, { agentId: AGENT, toolkit: "gmail" }, factory);
  assert.notEqual(reconnected.account.id, account.id);
  assert.equal((await service.listComposioAccountViews(database, OWNER, AGENT)).filter((row) => row.toolkit === "gmail").length, 1);
  await data.updateComposioAccount(database, OWNER, reconnected.account.id, { status: "failed" });
  const retried = await service.connectComposioAccount(database, OWNER, { agentId: AGENT, toolkit: "gmail" }, factory);
  assert.notEqual(retried.account.id, reconnected.account.id);

  const afterKey = await service.removeComposioKey(database, OWNER);
  assert.equal(afterKey.hasKey, false);
  const audit = await adminPool.query("select kind from audit_log where owner_id = $1 order by seq", [OWNER]);
  const kinds = audit.rows.map((row) => row.kind);
  for (const kind of ["composio_key_saved", "composio_account_connected", "composio_account_revoked", "composio_key_removed"]) {
    assert.equal(kinds.includes(kind), true, kind);
  }
});
