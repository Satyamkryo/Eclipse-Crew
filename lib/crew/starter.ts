import "server-only";

import { randomInt, randomUUID } from "node:crypto";
import { and, eq, inArray, lt, or } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { agents, starterCrewMembers, starterCrewSetups } from "../../db/schema";
import type { AgentTemplate, AgentTemplateId } from "../agents/templates";
import { AGENT_TEMPLATES } from "../agents/templates";
import type { AgentCreateInput } from "../agents/schema";
import { createAgentIdentity, provisionAgentForOwner, type DesktopOperations } from "../agents/service";
import type { StarterCrewView, StarterMemberView } from "./schema";

type Database = Awaited<ReturnType<typeof getDatabase>>;
const STALE_CLAIM_MS = 30_000;
const TEMPLATE_ORDER = new Map(AGENT_TEMPLATES.map((template, index) => [template.id, index]));

function cents(usd: string): number {
  const [whole, fraction = ""] = usd.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

// A template becomes the same create input the owner could type in the normal form. Nothing is added beyond the template.
export function templateCreateInput(template: AgentTemplate): AgentCreateInput {
  return {
    name: template.label,
    role: template.role,
    instructions: template.instructions,
    soulMd: "",
    anyPublicWeb: false,
    avatarVariant: randomInt(12),
    dailyBudgetCents: cents(template.dailyBudgetUsd),
    monthlyBudgetCents: cents(template.monthlyBudgetUsd),
    tools: [...template.tools],
    domains: [...template.domains],
    actions: [...template.actions],
    memoryScopes: [...template.memoryScopes] as AgentCreateInput["memoryScopes"],
  };
}

async function ensureSetup(database: Database, ownerId: string) {
  return database.transaction(async (transaction) => {
    const existing = await transaction.select({ id: starterCrewSetups.id, state: starterCrewSetups.state, updatedAt: starterCrewSetups.updatedAt })
      .from(starterCrewSetups).where(eq(starterCrewSetups.ownerId, ownerId)).limit(1);
    let setup = existing[0];
    if (!setup) {
      await transaction.insert(starterCrewSetups).values({ id: randomUUID(), ownerId })
        .onConflictDoNothing({ target: starterCrewSetups.ownerId });
      const rows = await transaction.select({ id: starterCrewSetups.id, state: starterCrewSetups.state, updatedAt: starterCrewSetups.updatedAt })
        .from(starterCrewSetups).where(eq(starterCrewSetups.ownerId, ownerId)).limit(1);
      if (!rows[0]) throw new Error("starter_setup_failed");
      setup = rows[0];
    }
    const members = await transaction.select({ id: starterCrewMembers.id }).from(starterCrewMembers)
      .where(and(eq(starterCrewMembers.ownerId, ownerId), eq(starterCrewMembers.setupId, setup.id))).limit(1);
    if (!members[0]) {
      await transaction.insert(starterCrewMembers).values(AGENT_TEMPLATES.map((template) => ({
        id: randomUUID(),
        ownerId,
        setupId: setup.id,
        templateId: template.id,
        agentId: randomUUID(),
        state: "pending" as const,
      }))).onConflictDoNothing({ target: [starterCrewMembers.setupId, starterCrewMembers.templateId] });
    }
    return setup;
  });
}

// One atomic claim per member. A concurrent request loses the claim and simply reports progress; a crash leaves
// `creating`, which a later request may reclaim once it is stale. The preallocated UUID is never replaced.
async function claimMember(database: Database, ownerId: string, setupId: string, templateId: string) {
  const now = new Date();
  const stale = new Date(now.getTime() - STALE_CLAIM_MS);
  const rows = await database.update(starterCrewMembers)
    .set({ state: "creating", errorCode: null, updatedAt: now })
    .where(and(
      eq(starterCrewMembers.ownerId, ownerId),
      eq(starterCrewMembers.setupId, setupId),
      eq(starterCrewMembers.templateId, templateId),
      or(
        inArray(starterCrewMembers.state, ["pending", "failed"]),
        and(eq(starterCrewMembers.state, "creating"), lt(starterCrewMembers.updatedAt, stale)),
      ),
    ))
    .returning({ id: starterCrewMembers.id, agentId: starterCrewMembers.agentId });
  return rows[0] ?? null;
}

async function finishMember(
  database: Database, ownerId: string, id: string, state: "created" | "failed", errorCode: string | null,
) {
  await database.update(starterCrewMembers).set({ state, errorCode, updatedAt: new Date() })
    .where(and(eq(starterCrewMembers.ownerId, ownerId), eq(starterCrewMembers.id, id)));
}

async function finalizeSetup(database: Database, ownerId: string, setupId: string) {
  const rows = await database.select({ state: starterCrewMembers.state }).from(starterCrewMembers)
    .where(and(eq(starterCrewMembers.ownerId, ownerId), eq(starterCrewMembers.setupId, setupId)));
  const state = rows.length > 0 && rows.every((row) => row.state === "created") ? "complete" : "partial";
  await database.update(starterCrewSetups).set({ state, updatedAt: new Date() })
    .where(and(eq(starterCrewSetups.ownerId, ownerId), eq(starterCrewSetups.id, setupId)));
}

export async function getStarterCrew(database: Database, ownerId: string): Promise<StarterCrewView> {
  const setupRows = await database.select({ id: starterCrewSetups.id, state: starterCrewSetups.state, updatedAt: starterCrewSetups.updatedAt })
    .from(starterCrewSetups).where(eq(starterCrewSetups.ownerId, ownerId)).limit(1);
  const setup = setupRows[0];
  if (!setup) return { setup: null, members: [], summary: { total: 0, created: 0, failed: 0, inProgress: 0 } };

  const members = await database.select({
    templateId: starterCrewMembers.templateId,
    agentId: starterCrewMembers.agentId,
    state: starterCrewMembers.state,
    errorCode: starterCrewMembers.errorCode,
    agentName: agents.name,
    agentStatus: agents.status,
  }).from(starterCrewMembers)
    .leftJoin(agents, and(eq(agents.id, starterCrewMembers.agentId), eq(agents.ownerId, ownerId)))
    .where(and(eq(starterCrewMembers.ownerId, ownerId), eq(starterCrewMembers.setupId, setup.id)));

  const ordered: StarterMemberView[] = members
    .sort((left, right) => (TEMPLATE_ORDER.get(left.templateId as AgentTemplateId) ?? 99) - (TEMPLATE_ORDER.get(right.templateId as AgentTemplateId) ?? 99))
    .map((member) => ({
      templateId: member.templateId,
      agentId: member.agentId,
      state: member.state as StarterMemberView["state"],
      errorCode: member.errorCode,
      agentName: member.agentName ?? null,
      agentStatus: member.agentStatus === "active" || member.agentStatus === "paused" ? member.agentStatus : null,
    }));

  return {
    setup: { id: setup.id, state: setup.state as "creating" | "partial" | "complete", updatedAt: setup.updatedAt.toISOString() },
    members: ordered,
    summary: {
      total: ordered.length,
      created: ordered.filter((member) => member.state === "created").length,
      failed: ordered.filter((member) => member.state === "failed").length,
      inProgress: ordered.filter((member) => member.state === "creating" || member.state === "pending").length,
    },
  };
}

// Creates the one setup for this owner (or resumes it) and processes every member that is not already created.
export async function createOrResumeStarterCrew(
  database: Database, ownerId: string, desktop?: DesktopOperations,
): Promise<StarterCrewView> {
  const setup = await ensureSetup(database, ownerId);
  for (const template of AGENT_TEMPLATES) {
    const member = await claimMember(database, ownerId, setup.id, template.id);
    if (!member) continue;
    try {
      await createAgentIdentity(database, ownerId, templateCreateInput(template), member.agentId);
    } catch {
      await finishMember(database, ownerId, member.id, "failed", "agent_create_failed");
      continue;
    }
    const provisioned = await provisionAgentForOwner(database, ownerId, member.agentId, desktop);
    await finishMember(database, ownerId, member.id, provisioned.ready ? "created" : "failed", provisioned.ready ? null : provisioned.code ?? "desktop_setup_failed");
  }
  await finalizeSetup(database, ownerId, setup.id);
  return getStarterCrew(database, ownerId);
}
