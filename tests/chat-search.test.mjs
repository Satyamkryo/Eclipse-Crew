import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { searchHistory } from "../lib/chat/search.ts";

const docker = (args) => spawnSync("docker", args, { encoding: "utf8", timeout: 120000 });
const dockerUp = docker(["version", "--format", "{{.Server.Version}}"]).status === 0;
const name = `eclipse-search-${randomBytes(6).toString("hex")}`;
const password = randomBytes(16).toString("hex");
const OWNER = randomUUID(); const OTHER = randomUUID();
const AGENT_A = randomUUID(); const AGENT_B = randomUUID();
const SESSION_A = randomUUID(); const SESSION_B = randomUUID();
let adminPool; let appPool; let app;

const skip = !dockerUp && "Docker is not available";

test.before(async () => {
  if (!dockerUp) return;
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
  assert.ok(adminPool);
  await adminPool.query(`
    CREATE TABLE chat_sessions (id uuid PRIMARY KEY, owner_id uuid NOT NULL, agent_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE messages (id uuid PRIMARY KEY, owner_id uuid NOT NULL, session_id uuid NOT NULL, role text NOT NULL, card_type text NOT NULL DEFAULT 'message',
      content jsonb NOT NULL, source_tag text NOT NULL DEFAULT 'user', run_id uuid, created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX messages_search_idx ON messages USING gin (to_tsvector('simple', coalesce(content->>'text','') || ' ' || coalesce(content->>'question','')));
    CREATE ROLE app_role LOGIN PASSWORD '${password}';
    GRANT SELECT, INSERT ON chat_sessions TO app_role;
    GRANT SELECT, INSERT ON messages TO app_role;`);
  await adminPool.query("INSERT INTO chat_sessions(id,owner_id,agent_id) VALUES ($1,$2,$3),($4,$5,$6)", [SESSION_A, OWNER, AGENT_A, SESSION_B, OWNER, AGENT_B]);
  const insert = (owner, session, role, text, minutes) => adminPool.query(
    "INSERT INTO messages(id,owner_id,session_id,role,content,created_at) VALUES ($1,$2,$3,$4,$5,now() - make_interval(mins => $6))",
    [randomUUID(), owner, session, role, JSON.stringify({ text }), minutes]);
  await insert(OWNER, SESSION_A, "user", "What did I say about the vendor contract in October?", 30);
  await insert(OWNER, SESSION_A, "agent", "You said the vendor contract renews in October.", 29);
  await insert(OWNER, SESSION_A, "user", "The weather is fine.", 20);
  await insert(OWNER, SESSION_B, "user", "The vendor contract is secret for the other agent.", 10);
  await insert(OTHER, SESSION_A, "user", "Another owner must never appear.", 5);
  appPool = new pg.Pool({ host: "127.0.0.1", port, user: "app_role", password, database: "postgres" });
  app = drizzle({ client: appPool });
});

test.after(async () => {
  await appPool?.end().catch(() => {}); await adminPool?.end().catch(() => {});
  if (dockerUp) docker(["rm", "-f", name]);
});

test("search_history finds only the calling agent's own chat, with bounded snippets and dates", { skip }, async () => {
  const hits = await searchHistory(app, OWNER, AGENT_A, "vendor contract");
  assert.equal(hits.length, 2);
  assert.ok(hits.every((hit) => hit.snippet.length > 0 && hit.snippet.length <= 300));
  assert.ok(hits.every((hit) => Number.isFinite(Date.parse(hit.date))));
  assert.ok(hits[0].snippet.includes("vendor"));
  assert.ok(!hits.some((hit) => hit.snippet.includes("secret")), "another agent's chat is never searched");

  const other = await searchHistory(app, OWNER, AGENT_B, "secret");
  assert.equal(other.length, 1, "the other agent sees its own chat");
  assert.ok(other[0].snippet.includes("secret"));
});

test("search_history returns nothing for an empty or unmatched query, and never crosses owners", { skip }, async () => {
  assert.deepEqual(await searchHistory(app, OWNER, AGENT_A, ""), []);
  assert.deepEqual(await searchHistory(app, OWNER, AGENT_A, "zebra"), []);
  const foreign = await searchHistory(app, OTHER, AGENT_A, "vendor");
  assert.equal(foreign.length, 0, "owner scoping removes the first owner's messages");
});
