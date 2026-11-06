import "server-only";

import { randomInt, randomUUID } from "node:crypto";
import { and, eq, inArray, lt, or } from "drizzle-orm";
import { z } from "zod";

import type { getDatabase } from "../../db/client";
import { agents, crewMembers, crews } from "../../db/schema";
import type { DesktopOperations } from "../agents/service";
import { KNOWN_ACTIONS } from "../agents/actions";
import { budgetUsdSchema, defaultInstructions, instructionsSchema, soulMdSchema, type AgentCreateInput } from "../agents/schema";
import { createAgentIdentity, provisionAgentForOwner } from "../agents/service";

type Database = Awaited<ReturnType<typeof getDatabase>>;

// Custom crews: an owner-named group of at most 6 agents. Only the crew name
// and each member's name + role are required. Persona, budgets and the
// permission set fill from safe defaults; tools are the read/deliver file
// actions and every default-deny screen/memory action — never tool_call,
// shell or subagents, which stay explicit opt-ins.
export const MAX_CREW_MEMBERS = 6;
const DEFAULT_DAILY_CENTS = 500;
const DEFAULT_MONTHLY_CENTS = 5000;

const memberInputSchema = z.object({
  name: z.string().trim().min(1).max(80).refine(
    (value) => !/[\x00-\x1f\x7f]/.test(value), "must be a single line without control characters"),
  role: z.string().trim().min(1).max(80).refine(
    (value) => !/[\x00-\x1f\x7f]/.test(value), "must be a single line without control characters"),
  instructions: instructionsSchema.optional(),
  soulMd: soulMdSchema.optional(),
  avatarVariant: z.number().int().min(0).max(11).optional(),
  dailyBudgetUsd: budgetUsdSchema.optional(),
  monthlyBudgetUsd: budgetUsdSchema.optional(),
}).strict();

export const crewCreateSchema = z.object({
  name: z.string().trim().min(1).max(80).refine(
    (value) => !/[\x00-\x1f\x7f]/.test(value), "must be a single line without control characters"),
  description: z.string().trim().max(500).default(""),
  members: z.array(memberInputSchema).min(1).max(MAX_CREW_MEMBERS),
}).strict().superRefine((value, context) => {
  const names = value.members.map((member) => member.name.toLowerCase());
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "member names must be unique", path: ["members"] });
  }
});

export type CrewMemberDraft = z.infer<typeof memberInputSchema>;
export type CrewCreateInput = z.infer<typeof crewCreateSchema>;

export type CrewMemberState = "pending" | "creating" | "ready" | "failed";

export interface CrewMemberView {
  memberId: string;
  agentId: string;
  role: string;
  state: CrewMemberState;
  errorCode: string | null;
  agentName: string | null;
  agentStatus: "active" | "paused" | null;
}

export interface CrewView {
  id: string;
  name: string;
  description: string;
  members: CrewMemberView[];
  summary: { total: number; ready: number; failed: number; inProgress: number };
  /** True when Retry would do something: a member failed, or one was left pending/creating past the stale window. */
  retryable: boolean;
  createdAt: string;
}

export function crewMemberCreateInput(member: CrewMemberDraft): AgentCreateInput {
  return {
    name: member.name,
    role: member.role,
    instructions: member.instructions?.trim() || defaultInstructions(member.name, member.role),
    soulMd: member.soulMd ?? "",
    avatarVariant: member.avatarVariant ?? randomInt(12),
    dailyBudgetCents: member.dailyBudgetUsd ?? DEFAULT_DAILY_CENTS,
    monthlyBudgetCents: member.monthlyBudgetUsd ?? DEFAULT_MONTHLY_CENTS,
    tools: [],
    domains: [],
    // ADR-036. Crew members get the same any-public-website default as standalone agents.
    anyPublicWeb: true,
    actions: [...KNOWN_ACTIONS],
    memoryScopes: ["global", "agent"],
  };
}

// A `creating` claim older than this is treated as abandoned (the app restarted or the request died mid-setup) and may
// be reclaimed by Retry. It is longer than one member's create + desktop start, so a live setup is never taken over.
export const STALE_CLAIM_MS = 3 * 60_000;

async function finishMember(
  database: Database, ownerId: string, id: string, state: CrewMemberState, errorCode: string | null,
) {
  await database.update(crewMembers).set({ state, errorCode, updatedAt: new Date() })
    .where(and(eq(crewMembers.ownerId, ownerId), eq(crewMembers.id, id)));
}

// One atomic claim per member: pending, failed, or an abandoned `creating`. A concurrent create or retry loses the
// claim and leaves that member alone. The preallocated agent UUID never changes.
async function claimMember(database: Database, ownerId: string, crewId: string, memberId: string, now: Date) {
  const stale = new Date(now.getTime() - STALE_CLAIM_MS);
  const rows = await database.update(crewMembers)
    .set({ state: "creating", errorCode: null, updatedAt: now })
    .where(and(
      eq(crewMembers.ownerId, ownerId),
      eq(crewMembers.crewId, crewId),
      eq(crewMembers.id, memberId),
      or(
        inArray(crewMembers.state, ["pending", "failed"]),
        and(eq(crewMembers.state, "creating"), lt(crewMembers.updatedAt, stale)),
      ),
    ))
    .returning({ id: crewMembers.id });
  return rows.length > 0;
}

// Creates the crew row and every member row, then sets up each agent.
export async function createCrew(
  database: Database, ownerId: string, input: CrewCreateInput, desktop?: DesktopOperations,
): Promise<CrewView> {
  const crewId = randomUUID();
  await database.insert(crews).values({
    id: crewId, ownerId, name: input.name, description: input.description,
  });
  for (const member of input.members) {
    await database.insert(crewMembers).values({
      id: randomUUID(), ownerId, crewId, agentId: randomUUID(),
      agentName: member.name, role: member.role, state: "pending",
    });
  }
  const drafts = new Map(input.members.map((member) => [member.name.toLowerCase(), member]));
  return processCrew(database, ownerId, crewId, drafts, desktop);
}

// Retry: resumes every member that failed, never started, or was abandoned mid-setup. The agent record is created only
// if it is missing (same UUID); when it already exists, the persona and budgets saved at create time are kept.
// Returns null when the crew is not the owner's.
export async function retryCrew(
  database: Database, ownerId: string, crewId: string, desktop?: DesktopOperations, now = new Date(),
): Promise<CrewView | null> {
  if (!(await getCrew(database, ownerId, crewId))) return null;
  return processCrew(database, ownerId, crewId, null, desktop, now);
}

async function processCrew(
  database: Database, ownerId: string, crewId: string, drafts: Map<string, CrewMemberDraft> | null,
  desktop?: DesktopOperations, now = new Date(),
): Promise<CrewView> {
  const rows = await database.select().from(crewMembers)
    .where(and(eq(crewMembers.ownerId, ownerId), eq(crewMembers.crewId, crewId)));
  for (const row of rows) {
    if (!(await claimMember(database, ownerId, crewId, row.id, now))) continue;
    // On retry the form is gone: name and role come from the member row and the rest from the safe defaults. These
    // are used only if the agent record was never written.
    const draft = drafts?.get(row.agentName.toLowerCase()) ?? { name: row.agentName, role: row.role };
    try {
      await createAgentIdentity(database, ownerId, crewMemberCreateInput(draft), row.agentId);
    } catch {
      await finishMember(database, ownerId, row.id, "failed", "agent_create_failed");
      continue;
    }
    const provisioned = await provisionAgentForOwner(database, ownerId, row.agentId, desktop);
    await finishMember(database, ownerId, row.id, provisioned.ready ? "ready" : "failed",
      provisioned.ready ? null : provisioned.code ?? "desktop_setup_failed");
  }
  const view = await getCrew(database, ownerId, crewId);
  if (!view) throw new Error("crew_not_found");
  return view;
}

export async function listCrews(database: Database, ownerId: string): Promise<CrewView[]> {
  const rows = await database.select({ id: crews.id }).from(crews)
    .where(eq(crews.ownerId, ownerId));
  const views: CrewView[] = [];
  for (const row of rows) {
    const view = await getCrew(database, ownerId, row.id);
    if (view) views.push(view);
  }
  return views;
}

export async function getCrew(database: Database, ownerId: string, crewId: string, now = new Date()): Promise<CrewView | null> {
  const crewRows = await database.select().from(crews)
    .where(and(eq(crews.ownerId, ownerId), eq(crews.id, crewId))).limit(1);
  const crew = crewRows[0];
  if (!crew) return null;
  const members = await database.select({
    memberId: crewMembers.id, agentId: crewMembers.agentId, role: crewMembers.role,
    state: crewMembers.state, errorCode: crewMembers.errorCode, updatedAt: crewMembers.updatedAt,
    agentName: agents.name, agentStatus: agents.status,
  }).from(crewMembers)
    .leftJoin(agents, and(eq(agents.id, crewMembers.agentId), eq(agents.ownerId, ownerId)))
    .where(and(eq(crewMembers.ownerId, ownerId), eq(crewMembers.crewId, crewId)));
  const ordered: CrewMemberView[] = members.map((member) => ({
    memberId: member.memberId,
    agentId: member.agentId,
    role: member.role,
    state: member.state as CrewMemberState,
    errorCode: member.errorCode,
    agentName: member.agentName,
    agentStatus: (member.agentStatus === "active" || member.agentStatus === "paused" ? member.agentStatus : null) as CrewMemberView["agentStatus"],
  }));
  const stale = now.getTime() - STALE_CLAIM_MS;
  const retryable = members.some((member) => member.state === "failed" ||
    ((member.state === "pending" || member.state === "creating") && member.updatedAt.getTime() < stale));
  return {
    id: crew.id,
    name: crew.name,
    description: crew.description,
    createdAt: crew.createdAt.toISOString(),
    retryable,
    members: ordered,
    summary: {
      total: ordered.length,
      ready: ordered.filter((member) => member.state === "ready").length,
      failed: ordered.filter((member) => member.state === "failed").length,
      inProgress: ordered.filter((member) => member.state === "creating" || member.state === "pending").length,
    },
  };
}

// Crew ids an agent belongs to. Used to scope handoffs inside a shared crew.
export async function crewIdsForAgent(database: Database, ownerId: string, agentId: string): Promise<string[]> {
  const rows = await database.select({ crewId: crewMembers.crewId }).from(crewMembers)
    .where(and(eq(crewMembers.ownerId, ownerId), eq(crewMembers.agentId, agentId)));
  return rows.map((row) => row.crewId);
}

// Two agents may hand off only when they share at least one custom crew (the runtime check in lib/agent/handoff.ts
// also counts the starter crew, via lib/crew/groups.ts).
export async function shareCrew(database: Database, ownerId: string, senderAgentId: string, receiverAgentId: string): Promise<boolean> {
  const [sender, receiver] = await Promise.all([
    crewIdsForAgent(database, ownerId, senderAgentId),
    crewIdsForAgent(database, ownerId, receiverAgentId),
  ]);
  // ADR-036. A sender in no crew never hands off on its own.
  if (sender.length === 0) return false;
  return receiver.some((crewId) => sender.includes(crewId));
}
