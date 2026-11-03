import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { KNOWN_ACTIONS, notAllowedText } from "../lib/agents/actions.ts";

// Runs the real migration files on a throwaway Postgres, with seeded agent policies from before the change.
const docker = (args, input) => spawnSync("docker", args, { input, encoding: "utf8", timeout: 120_000 });
const dockerAvailable = docker(["version", "--format", "{{.Server.Version}}"]).status === 0;

test("the known action list covers desktop and file actions and the stop text says where to change it", () => {
  assert.deepEqual([...KNOWN_ACTIONS], ["click", "type", "key", "scroll", "wait", "start_desktop", "start_browser", "read_document", "deliver_file", "remember"]);
  const text = notAllowedText("read_document");
  assert.match(text, /"read_document" action/);
  assert.match(text, /Add "read_document" to this agent's Actions in its settings/);
});

test("migration 0008 adds the file actions only to non-empty lists and is idempotent", { skip: !dockerAvailable && "needs Docker" }, async (t) => {
  const name = `ec-actions-${randomBytes(4).toString("hex")}`;
  assert.equal(docker(["run", "-d", "--name", name, "-e", "POSTGRES_PASSWORD=x", "postgres:17-alpine"]).status, 0);
  t.after(() => docker(["rm", "-f", name]));
  for (let attempt = 0; attempt < 60; attempt++) {
    if (docker(["exec", name, "pg_isready", "-U", "postgres"]).stdout?.includes("accepting")) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const psql = (sql) => {
    const run = docker(["exec", "-i", name, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-At"], sql);
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  const files = readdirSync("drizzle").filter((file) => file.endsWith(".sql")).sort();
  const index = files.findIndex((file) => file.startsWith("0008_"));
  assert.notEqual(index, -1, "migration 0008 exists");
  for (const file of files.slice(0, index)) psql(readFileSync(`drizzle/${file}`, "utf8").replaceAll("--> statement-breakpoint", ""));

  const owner = "11111111-1111-4111-8111-111111111111";
  const seed = (id, actions) => `INSERT INTO agents (id, owner_id, name, role, soul_md, status, daily_budget_cents, monthly_budget_cents) VALUES ('${id}','${owner}','a${id.slice(0, 4)}','r','s','active',100,100);
    INSERT INTO agent_policies (agent_id, owner_id, tools, domains, actions, memory_scopes) VALUES ('${id}','${owner}','{}','{}','${actions}','{}');`;
  const ids = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "dddddddd-dddd-4ddd-8ddd-dddddddddddd"];
  psql(`INSERT INTO owner (id, owner_id, login, password_hash, timezone) VALUES ('${owner}','${owner}','o@example.test','x','UTC');`);
  const columns = psql("SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_name = 'agents'");
  assert.match(columns, /soul_md/);
  psql(seed(ids[0], "{click}") + seed(ids[1], "{}") + seed(ids[2], "{click,read_document}") + seed(ids[3], "{click,type,deliver_file,read_document}"));

  const migration = readFileSync(`drizzle/${files[index]}`, "utf8");
  const read = () => psql("SELECT agent_id || '=' || array_to_string(actions, ',') FROM agent_policies ORDER BY agent_id").split("\n");
  psql(migration);
  const after = read();
  assert.deepEqual(after, [`${ids[0]}=click,read_document,deliver_file`, `${ids[1]}=`, `${ids[2]}=click,read_document,deliver_file`, `${ids[3]}=click,type,deliver_file,read_document`]);
  psql(migration);
  assert.deepEqual(read(), after, "a second run changes nothing");
});
