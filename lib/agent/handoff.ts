import "server-only";

import { and, eq, gt, isNull } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { agentPolicies, messages, runMeta, runs } from "../../db/schema";
import { appendUserMessage } from "../chat/data";
import { listAgentRecords } from "../agents/data";
import { isAgentBusy } from "./step-loop";
import { recordAuditBestEffort } from "../security/audit";

type Database = Awaited<ReturnType<typeof getDatabase>>;

// TASK-085. Fixed refusal codes. The sender's run continues after a refusal, so it can do the work itself or ask.
export type HandoffCode =
  | "teammate_unavailable" | "handoff_to_self" | "handoff_cycle" | "handoff_limit"
  | "no_owner_message" | "invalid_note" | "start_failed";

export interface HandoffInput {
  database: Database;
  ownerId: string;
  senderAgentId: string;
  senderAgentName: string;
  senderRunId: string;
  task: string;
  // The stored owner message this run was started from. Handoff copies that row's text, never model text.
  sourceMessageId?: string | null;
  agent: string;
  note: string;
}

export type HandoffResult = { ok: true; receiverAgentId: string; receiverName: string } | { ok: false; code: HandoffCode };

const MAX_NOTE = 1000;
const MAX_HOPS = 2;
const BUSY_WINDOW_MS = 90_000;

export function validHandoffNote(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0 && [...value.trim()].length <= MAX_NOTE &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

// The owner's exact words, read fresh from the database. A run that was not started from a stored owner message
// (a routine, replay, heal or helper) cannot hand off: only the owner gives orders.
async function ownerMessage(database: Database, ownerId: string, messageId: string | null | undefined, task: string) {
  if (!messageId) return null;
  const rows = await database.select({ text: messages.content }).from(messages)
    .where(and(eq(messages.ownerId, ownerId), eq(messages.id, messageId), eq(messages.role, "user"))).limit(1);
  const content = rows[0]?.text as { type?: string; text?: unknown } | undefined;
  if (!content || content.type !== "message" || typeof content.text !== "string") return null;
  // The stored text is authoritative; a mismatch means the caller is not the run it claims to be.
  if (content.text !== task) return null;
  return { id: messageId, text: content.text };
}

// Walks the handoff chain backwards through run_meta.handoff_of. Returns every agent that already had the request
// and how many handoffs have happened (the chain length, not counting the current sender run).
async function handoffChain(database: Database, ownerId: string, runId: string): Promise<{ hops: number; agents: string[] }> {
  const agents: string[] = [];
  let hops = 0;
  let current = runId;
  for (let depth = 0; depth < MAX_HOPS + 2; depth++) {
    const rows = await database.select({ handoffOf: runMeta.handoffOf, agentId: runMeta.agentId }).from(runMeta)
      .where(and(eq(runMeta.ownerId, ownerId), eq(runMeta.runId, current))).limit(1);
    const row = rows[0];
    if (!row) break;
    agents.push(row.agentId);
    if (!row.handoffOf) break;
    hops += 1;
    current = row.handoffOf;
  }
  return { hops, agents };
}

async function receiverBusy(database: Database, ownerId: string, agentId: string, now: Date): Promise<boolean> {
  if (isAgentBusy(agentId)) return true;
  const rows = await database.select({ id: runs.id }).from(runs)
    .where(and(eq(runs.ownerId, ownerId), eq(runs.agentId, agentId), isNull(runs.signature), gt(runs.heartbeatAt, new Date(now.getTime() - BUSY_WINDOW_MS))))
    .limit(1);
  return Boolean(rows[0]);
}

// Hands one request to one teammate. The receiver's task is a copy of the stored owner message; the sender's note
// is data and never enters the task. Starts the receiver through the caller's fire-and-forget launcher.
export async function performHandoff(
  input: HandoffInput,
  startReceiver: (receiverAgentId: string, text: string, messageId: string) => void,
  now = new Date(),
): Promise<HandoffResult> {
  if (!validHandoffNote(input.note)) return { ok: false, code: "invalid_note" };
  const name = input.agent.trim().toLowerCase();
  const teammates = await listAgentRecords(input.database, input.ownerId);
  const receiver = teammates.find((agent) => agent.name.trim().toLowerCase() === name);
  if (!receiver) return { ok: false, code: "teammate_unavailable" };
  if (receiver.id === input.senderAgentId) return { ok: false, code: "handoff_to_self" };
  if (receiver.status !== "active") return { ok: false, code: "teammate_unavailable" };

  const chain = await handoffChain(input.database, input.ownerId, input.senderRunId);
  if (chain.hops >= MAX_HOPS) return { ok: false, code: "handoff_limit" };
  if (chain.agents.includes(receiver.id) || receiver.id === input.senderAgentId) return { ok: false, code: "handoff_cycle" };

  const message = await ownerMessage(input.database, input.ownerId, input.sourceMessageId, input.task);
  if (!message) return { ok: false, code: "no_owner_message" };

  if (await receiverBusy(input.database, input.ownerId, receiver.id, now)) return { ok: false, code: "teammate_unavailable" };

  let copy;
  try {
    copy = await appendUserMessage(input.database, input.ownerId, receiver.id, message.text, { fromAgent: input.senderAgentName });
  } catch {
    return { ok: false, code: "start_failed" };
  }
  try {
    startReceiver(receiver.id, message.text, copy.id);
  } catch {
    await recordAuditBestEffort(input.database, input.ownerId, {
      kind: "run_handed_off", agentId: input.senderAgentId, runId: input.senderRunId, ref: receiver.id, code: "start_failed",
    });
    return { ok: false, code: "start_failed" };
  }
  await recordAuditBestEffort(input.database, input.ownerId, {
    kind: "run_handed_off", agentId: input.senderAgentId, runId: input.senderRunId, ref: receiver.id, code: "sent",
  });
  await recordAuditBestEffort(input.database, input.ownerId, {
    kind: "run_handed_off", agentId: receiver.id, ref: input.senderAgentId, code: "received",
  });
  return { ok: true, receiverAgentId: receiver.id, receiverName: receiver.name };
}

// TASK-085. The model-facing list is names, roles, state and app names only. It never includes another agent's
// permissions, connections or keys.
export async function loadTeammates(database: Database, ownerId: string, exceptAgentId: string) {
  const rows = await listAgentRecords(database, ownerId);
  const policies = await database.select({ agentId: agentPolicies.agentId, tools: agentPolicies.tools }).from(agentPolicies)
    .where(eq(agentPolicies.ownerId, ownerId));
  const toolsByAgent = new Map(policies.map((policy) => [policy.agentId, policy.tools as string[]]));
  return rows
    .filter((row) => row.id !== exceptAgentId)
    .map((row) => ({ name: row.name, role: row.role, status: row.status, tools: toolsByAgent.get(row.id) ?? [] }));
}
