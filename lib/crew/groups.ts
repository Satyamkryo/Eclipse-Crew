import "server-only";

import { and, asc, eq } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { crewMembers, crews, starterCrewMembers } from "../../db/schema";

type Database = Awaited<ReturnType<typeof getDatabase>>;

// ADR-036. One view of "which crew is this agent in" for handoff scoping, the sidebar grouping and the crew handoff
// switch. The starter crew counts as a crew; custom crews are owner-created. An agent in no crew is a standard agent:
// it never hands off on its own (the owner can still route a message with @Name).
export interface CrewGroup {
  key: string;
  name: string;
  kind: "starter" | "custom";
  agentIds: string[];
}

export const STARTER_CREW_KEY = "starter";

export async function listCrewGroups(database: Database, ownerId: string): Promise<CrewGroup[]> {
  const [starter, customRows] = await Promise.all([
    database.select({ agentId: starterCrewMembers.agentId }).from(starterCrewMembers)
      .where(and(eq(starterCrewMembers.ownerId, ownerId), eq(starterCrewMembers.state, "created"))),
    database.select({ crewId: crews.id, name: crews.name, agentId: crewMembers.agentId })
      .from(crews).innerJoin(crewMembers, and(eq(crewMembers.crewId, crews.id), eq(crewMembers.ownerId, ownerId)))
      .where(eq(crews.ownerId, ownerId)).orderBy(asc(crews.name), asc(crewMembers.createdAt)),
  ]);
  const groups: CrewGroup[] = [];
  if (starter.length) groups.push({ key: STARTER_CREW_KEY, name: "Starter crew", kind: "starter", agentIds: starter.map((row) => row.agentId) });
  const custom = new Map<string, CrewGroup>();
  for (const row of customRows) {
    const group = custom.get(row.crewId) ?? { key: row.crewId, name: row.name, kind: "custom" as const, agentIds: [] };
    if (!group.agentIds.includes(row.agentId)) group.agentIds.push(row.agentId);
    custom.set(row.crewId, group);
  }
  return [...groups, ...custom.values()];
}

export async function crewKeysForAgent(database: Database, ownerId: string, agentId: string): Promise<string[]> {
  return (await listCrewGroups(database, ownerId)).filter((group) => group.agentIds.includes(agentId)).map((group) => group.key);
}

/** The agents that share at least one crew with `agentId` (never `agentId` itself). Empty for a standard agent. */
export async function crewmateIds(database: Database, ownerId: string, agentId: string): Promise<Set<string>> {
  const mates = new Set<string>();
  for (const group of await listCrewGroups(database, ownerId)) {
    if (!group.agentIds.includes(agentId)) continue;
    for (const id of group.agentIds) if (id !== agentId) mates.add(id);
  }
  return mates;
}
