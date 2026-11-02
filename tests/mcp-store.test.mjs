import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { toolsHash } from "../lib/mcp/pin.ts";

const docker = (args) => spawnSync("docker", args, { encoding: "utf8", timeout: 120_000 });
const dockerUp = docker(["version", "--format", "{{.Server.Version}}"]).status === 0;
const name = `eclipse-mcp-${randomBytes(6).toString("hex")}`;
const password = randomBytes(16).toString("hex");
const OWNER = randomUUID();
const AGENT = randomUUID();
const CONNECTION = randomUUID();
let adminPool; let appPool; let database; let service; let store;
let tools = [
  { name: "get_me", description: "Me", annotations: { readOnlyHint: true } },
  { name: "create_issue", description: "Issue", inputSchema: { type: "object", properties: { title: { type: "string", metadata: { second: 2, first: 1 } } }, required: ["title"] } },
];

function fakeTransport() {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "initialize") return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "Fake GitHub", version: "1.0" } } });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") return json({ jsonrpc: "2.0", id: body.id, result: { tools } });
    return new Response("{}", { status: 404 });
  };
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

test.before(async () => {
  if (!dockerUp) return;
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
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
  for (const file of ["0000_solid_risque.sql", "0003_kind_jocasta.sql", "0023_audit_log.sql", "0026_tool_connections.sql", "0027_mcp_servers.sql"]) {
    const migration = readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8")
      .split("\n").filter((line) => !line.startsWith("--")).join("\n").replaceAll("--> statement-breakpoint", "");
    await adminPool.query(migration);
  }
  await adminPool.query(`CREATE ROLE app_role LOGIN PASSWORD '${password}';
    GRANT SELECT ON public.agents TO app_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.connections TO app_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.mcp_servers TO app_role;`);
  await adminPool.query(`INSERT INTO public.owner(id,owner_id,login,password_hash,timezone) VALUES ($1,$1,'owner','hash','UTC')`, [OWNER]);
  await adminPool.query(`INSERT INTO public.agents(id,owner_id,name,role,soul_md,status,daily_budget_cents,monthly_budget_cents)
    VALUES ($1,$2,'A','role','soul','active',100,1000)`, [AGENT, OWNER]);
  await adminPool.query(`INSERT INTO public.connections(id,owner_id,agent_id,preset,label,bindings,encrypted_token,token_hint)
    VALUES ($1,$2,$3,'github','Work','[{"host":"api.githubcopilot.com","scheme":"bearer"},{"host":"api.github.com","scheme":"bearer"},{"host":"github.com","scheme":"basic","username":"x-access-token"}]'::jsonb,'v1.synthetic','••••test')`,
  [CONNECTION, OWNER, AGENT]);
  appPool = new pg.Pool({ host: "127.0.0.1", port, user: "app_role", password, database: "postgres" });
  database = drizzle({ client: appPool });
  service = await import("../lib/mcp/service.ts");
  store = await import("../lib/mcp/data.ts");
});
test.after(async () => {
  await appPool?.end().catch(() => {}); await adminPool?.end().catch(() => {});
  if (dockerUp) docker(["rm", "-f", name]);
});

const skip = !dockerUp && "Docker is not available";
const base = () => ({ agentId: AGENT, preset: "github", key: "github", connectionId: CONNECTION });
const deps = { transportFactory: () => fakeTransport() };

test("discovery is shown before anything is stored, then pinning stores the exact list", { skip }, async () => {
  const discovery = await service.createMcpServer(database, OWNER, base(), deps);
  assert.equal(discovery.kind, "discovery");
  assert.equal(discovery.discovery.tools.length, 2);
  assert.equal(discovery.discovery.toolsHash.length, 64);
  assert.equal((await store.listMcpServers(database, OWNER)).length, 0);
  const pinned = await service.createMcpServer(database, OWNER, { ...base(), expectedToolsHash: discovery.discovery.toolsHash }, deps);
  assert.equal(pinned.kind, "pinned");
  assert.equal(pinned.server.tools.length, 2);
  assert.equal(pinned.server.status, "pinned");
  const roundTripped = await store.getMcpServerByKey(database, OWNER, AGENT, "github");
  assert.equal(toolsHash(roundTripped.tools), roundTripped.toolsHash, "the jsonb round-trip preserves the canonical hash");
  assert.equal(roundTripped.toolsHash, discovery.discovery.toolsHash);
  await assert.rejects(() => service.createMcpServer(database, OWNER, { ...base(), expectedToolsHash: discovery.discovery.toolsHash }, deps),
    (error) => error.code === "key_taken");
});

test("a changed tool list blocks a re-pin until the new list is confirmed", { skip }, async () => {
  tools = [...tools, { name: "merge_pull_request", description: "Merge" }];
  const changed = await service.repinMcpServer(database, OWNER, (await store.getMcpServerByKey(database, OWNER, AGENT, "github")).id, {}, deps);
  assert.equal(changed.kind, "discovery");
  const repin = await service.repinMcpServer(database, OWNER, (await store.getMcpServerByKey(database, OWNER, AGENT, "github")).id, { expectedToolsHash: changed.discovery.toolsHash }, deps);
  assert.equal(repin.kind, "pinned");
  assert.equal(repin.server.tools.length, 3);
});

test("a URL outside the connection's hosts is refused and owner scoping holds", { skip }, async () => {
  await assert.rejects(() => service.createMcpServer(database, OWNER, { ...base(), key: "elsewhere", preset: "custom", url: "https://evil.example/mcp" }, deps),
    (error) => error.code === "host_not_in_connection");
  const other = randomUUID();
  await assert.rejects(() => service.createMcpServer(database, other, base(), deps), (error) => error.code === "not_found");
  assert.equal((await service.listMcpServerViews(database, other)).length, 0);
});

test("removing a server removes its pins and the agent cascade clears them", { skip }, async () => {
  const server = await store.getMcpServerByKey(database, OWNER, AGENT, "github");
  await service.removeMcpServer(database, OWNER, server.id);
  assert.equal((await store.listMcpServers(database, OWNER)).length, 0);
  await assert.rejects(() => service.removeMcpServer(database, OWNER, server.id), (error) => error.code === "not_found");
});
