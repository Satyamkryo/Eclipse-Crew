import "server-only";

import { randomUUID } from "node:crypto";

import type { getDatabase } from "../../db/client";
import { securityEvents } from "../../db/schema";
import { appendAgentCard } from "../chat/data";
import { setAgentAttention } from "../costs/store";
import { desktopSession } from "../desktop/client";
import { tripAgent } from "../egress/sync";
import { cancelAgentRuns } from "../jobs/control";

type Database = Awaited<ReturnType<typeof getDatabase>>;

export type TripwireSource = "typed_text" | "proxy_host" | "proxy_request";

export interface TripwireEvent {
  ownerId: string;
  agentId: string;
  source: TripwireSource;
  runId?: string | null;
  // Stable per incident. The proxy uses `boot:seq`; the app uses `typed_text:<run>:<step>`.
  sourceRef: string;
}

export interface TripwirePorts {
  // True when this call inserted the incident; false means it was already recorded.
  record(event: TripwireEvent): Promise<boolean>;
  latch(ownerId: string, agentId: string): Promise<void>;
  cancelRuns(ownerId: string, agentId: string, exceptRunId?: string): void;
  stopSession(ownerId: string, agentId: string): Promise<boolean>;
  pause(ownerId: string, agentId: string): Promise<void>;
  postCard(ownerId: string, agentId: string, runId: string | null | undefined, sessionStopped: boolean): Promise<boolean>;
}

export interface TripwireResult { duplicate: boolean; cardPosted: boolean; sessionStopped: boolean }

export const SECURITY_STOP_TEXT =
  "I stopped because a security check found this agent's canary secret in data it was about to send. The desktop was stopped and the agent is paused. Review what happened, then resume the agent when you are ready.";
const DESKTOP_NOT_STOPPED_TEXT = " The desktop could not be stopped.";

const tripped = new Set<string>();
const tripKey = (ownerId: string, agentId: string) => `${ownerId}:${agentId}`;

// TASK-047. Fixed order so one failure never skips the rest: record, latch, cancel, stop, pause, one card.
export async function triggerTripwire(ports: TripwirePorts, event: TripwireEvent): Promise<TripwireResult> {
  const key = tripKey(event.ownerId, event.agentId);
  if (tripped.has(key)) return { duplicate: true, cardPosted: true, sessionStopped: true };
  tripped.add(key);

  let inserted = true;
  try { inserted = await ports.record(event); } catch { /* fail closed: the agent is still stopped */ }
  if (!inserted) return { duplicate: true, cardPosted: true, sessionStopped: true };

  try { await ports.latch(event.ownerId, event.agentId); } catch { /* the session stop still contains this agent */ }
  try { ports.cancelRuns(event.ownerId, event.agentId, event.runId ?? undefined); } catch { /* the pause still lands */ }

  let sessionStopped = false;
  try { sessionStopped = await ports.stopSession(event.ownerId, event.agentId); } catch { sessionStopped = false; }
  try { await ports.pause(event.ownerId, event.agentId); } catch { /* the card still tells the owner */ }

  let cardPosted = false;
  try { cardPosted = await ports.postCard(event.ownerId, event.agentId, event.runId, sessionStopped); } catch { cardPosted = false; }
  return { duplicate: false, cardPosted, sessionStopped };
}

export function clearTripwire(ownerId: string, agentId: string): void {
  tripped.delete(tripKey(ownerId, agentId));
}

export function isTripped(ownerId: string, agentId: string): boolean {
  return tripped.has(tripKey(ownerId, agentId));
}

export function createTripwirePorts(database: Database): TripwirePorts {
  return {
    async record(event) {
      const rows = await database.insert(securityEvents).values({
        id: randomUUID(),
        ownerId: event.ownerId,
        agentId: event.agentId,
        kind: "canary_leak",
        source: event.source,
        runId: event.runId ?? null,
        sourceRef: event.sourceRef,
      }).onConflictDoNothing({ target: securityEvents.sourceRef }).returning({ id: securityEvents.id });
      return rows.length > 0;
    },
    async latch(ownerId, agentId) {
      // TASK-045/047. The proxy refuses this agent until the owner resumes it; the stop and pause still contain it.
      await tripAgent(database, ownerId, agentId);
    },
    cancelRuns(ownerId, agentId, exceptRunId) {
      cancelAgentRuns(ownerId, agentId, exceptRunId ? { except: exceptRunId } : {});
    },
    async stopSession(ownerId, agentId) {
      const status = await desktopSession(agentId, ownerId, "session.stop");
      return status.state === "stopped";
    },
    async pause(ownerId, agentId) {
      await setAgentAttention(database, ownerId, agentId, "security_stop", { pause: true });
    },
    async postCard(ownerId, agentId, runId, sessionStopped) {
      await appendAgentCard(database, ownerId, agentId, {
        card: { type: "message", text: `${SECURITY_STOP_TEXT}${sessionStopped ? "" : DESKTOP_NOT_STOPPED_TEXT}` },
        sourceTag: "agent",
        ...(runId ? { runId } : {}),
      });
      return true;
    },
  };
}
