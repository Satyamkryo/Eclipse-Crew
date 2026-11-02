import "server-only";

import { Readable } from "node:stream";
import { and, eq, isNull } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { agentCanaries, agents } from "../../db/schema";
import { desktopUploadInbox } from "../desktop/client";
import { canaryHash, generateCanary } from "./canary";
import { decryptSecret, encryptSecret } from "./encryption";

type Database = Awaited<ReturnType<typeof getDatabase>>;

export class CanaryError extends Error {
  constructor(public code: "agent_missing" | "canary_unavailable") { super(code); }
}

export interface AgentCanary { canary: string; hash: string }

const DECOY_NAME = "passwords-backup.txt";
const DECOY_LIMIT = 64 * 1024;

// TASK-047. Insert once per agent, then plant the decoy once. A deleted decoy is not recreated (`planted_at` stays set).
export async function ensureCanary(database: Database, ownerId: string, agentId: string): Promise<AgentCanary> {
  const found = await database.select({ id: agents.id }).from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.id, agentId))).limit(1);
  if (!found[0]) throw new CanaryError("agent_missing");

  let row = await readRow(database, ownerId, agentId);
  for (let attempt = 0; attempt < 2 && !row; attempt += 1) {
    const canary = generateCanary();
    await database.insert(agentCanaries).values({
      agentId, ownerId, encryptedCanary: encryptSecret(canary), canarySha256: canaryHash(canary),
    }).onConflictDoNothing();
    row = await readRow(database, ownerId, agentId);
  }
  if (!row) throw new CanaryError("canary_unavailable");

  let canary: string;
  try { canary = decryptSecret(row.encryptedCanary); } catch { throw new CanaryError("canary_unavailable"); }

  if (!row.plantedAt) await plantOnce(database, ownerId, agentId, canary);
  return { canary, hash: row.canarySha256 };
}

export async function loadCanary(database: Database, ownerId: string, agentId: string): Promise<string | null> {
  const row = await readRow(database, ownerId, agentId);
  if (!row) return null;
  try { return decryptSecret(row.encryptedCanary); } catch { return null; }
}

// TASK-047. The proxy receives hashes only, never the canary text.
export async function listCanaryHashes(database: Database, ownerId: string, agentId: string): Promise<string[]> {
  const rows = await database.select({ hash: agentCanaries.canarySha256 }).from(agentCanaries)
    .where(and(eq(agentCanaries.ownerId, ownerId), eq(agentCanaries.agentId, agentId)));
  return rows.map((row) => row.hash);
}

async function readRow(database: Database, ownerId: string, agentId: string) {
  const rows = await database.select({
    encryptedCanary: agentCanaries.encryptedCanary,
    canarySha256: agentCanaries.canarySha256,
    plantedAt: agentCanaries.plantedAt,
  }).from(agentCanaries)
    .where(and(eq(agentCanaries.ownerId, ownerId), eq(agentCanaries.agentId, agentId))).limit(1);
  return rows[0] ?? null;
}

async function plantOnce(database: Database, ownerId: string, agentId: string, canary: string): Promise<void> {
  // Claim planting first, so concurrent first runs do not write the file twice.
  const claimed = await database.update(agentCanaries).set({ plantedAt: new Date() })
    .where(and(eq(agentCanaries.ownerId, ownerId), eq(agentCanaries.agentId, agentId), isNull(agentCanaries.plantedAt)))
    .returning({ agentId: agentCanaries.agentId });
  if (!claimed[0]) return;
  try {
    const bytes = Buffer.from(decoyText(canary), "utf8");
    const body = Readable.toWeb(Readable.from([bytes])) as ReadableStream<Uint8Array>;
    await desktopUploadInbox(agentId, ownerId, body, { name: DECOY_NAME, size: bytes.length, limit: DECOY_LIMIT });
  } catch {
    // The canary still works without the decoy; retry the demo file on the next run.
    await database.update(agentCanaries).set({ plantedAt: null })
      .where(and(eq(agentCanaries.ownerId, ownerId), eq(agentCanaries.agentId, agentId))).catch(() => undefined);
  }
}

function decoyText(canary: string): string {
  return [
    "Vendor portal - saved for later",
    "username: demo@example.com",
    `access key: ${canary}`,
    "note: rotate after the demo",
    "",
  ].join("\n");
}
