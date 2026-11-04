#!/usr/bin/env node
// TASK-085 close-out. Removes exactly the three verified desktop-only orphan fixtures. There is no generic admin
// surface here: the IDs are hard-coded, the app database must not know them, and deletion goes through the same
// authenticated internal controller command the app uses (`agent.delete`), which re-checks the owner, stops,
// paths and symlink boundaries in the desktop registry.
//
// Run from the trusted app process, inside the app container:
//   docker compose exec -T app node --conditions=react-server --import tsx scripts/acceptance/cleanup-orphan-fixtures.mjs --login <email>
//
// Pass --verify-only to perform every check without deleting.
import { and, eq, inArray } from "drizzle-orm";
import { getDatabase } from "../../db/client.ts";
import { agents, owner } from "../../db/schema.ts";
import { desktopDeleteAgent } from "../../lib/desktop/client.ts";

const ALLOWLIST = Object.freeze([
  "aaaa0000-0000-4000-8000-000000000001",
  "aaaa0000-0000-4000-8000-000000000002",
  "aaaa0000-0000-4000-8000-000000000003",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const verifyOnly = process.argv.includes("--verify-only");
// TASK-092. The fixture belongs to one account; name it explicitly instead of assuming the only owner.
const loginFlag = process.argv.indexOf("--login");
const login = loginFlag === -1 ? undefined : process.argv[loginFlag + 1]?.toLowerCase();
if (loginFlag === -1 || !login || !EMAIL.test(login) || login.length > 255) {
  console.error("refused: pass --login <email> to choose the account");
  process.exit(1);
}

function fail(message) {
  console.error(`refused: ${message}`);
  process.exit(1);
}

if (ALLOWLIST.length !== 3 || !ALLOWLIST.every((id) => UUID.test(id))) fail("the allowlist changed");
if (new Set(ALLOWLIST).size !== ALLOWLIST.length) fail("duplicate allowlist entry");

const database = await getDatabase();
const owners = await database.select({ id: owner.id, login: owner.login }).from(owner).where(eq(owner.login, login)).limit(2);
if (owners.length !== 1) fail(`no matching valid owner for ${login}`);
const ownerId = owners[0].id;

// An app row means this is not a desktop-only orphan. Never touch a live agent.
const live = await database.select({ id: agents.id }).from(agents)
  .where(and(eq(agents.ownerId, ownerId), inArray(agents.id, [...ALLOWLIST])));
if (live.length) fail(`app database still has ${live.map((row) => row.id).join(", ")}`);
const names = await database.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.ownerId, ownerId));
if (names.length === 0) console.warn("note: the owner has no agents; cleanup continues for the three fixed desktop records");

if (verifyOnly) {
  console.log(JSON.stringify({ ok: true, verifyOnly: true, ownerId, targets: ALLOWLIST }, null, 2));
  process.exit(0);
}

const removed = [];
for (const agentId of ALLOWLIST) {
  if (!ALLOWLIST.includes(agentId) || !UUID.test(agentId)) fail(`unexpected id ${agentId}`);
  try {
    const result = await desktopDeleteAgent(agentId, ownerId);
    if (result.agentId !== agentId) fail(`controller answered for ${result.agentId}`);
    removed.push(agentId);
  } catch (error) {
    // owner_mismatch, agent_processes_running, or a symlink/path refusal: stop at once, do not force anything.
    fail(`${agentId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const after = await database.select({ id: agents.id }).from(agents)
  .where(and(eq(agents.ownerId, ownerId), inArray(agents.id, [...ALLOWLIST])));
if (after.length) fail("an app row appeared during cleanup");

console.log(JSON.stringify({ ok: true, ownerId, removed, remaining: [] }, null, 2));
process.exit(0);
