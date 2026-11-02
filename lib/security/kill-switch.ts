import "server-only";

import { and, eq, sql } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { agents, owner } from "../../db/schema";
import { appendAgentCard } from "../chat/data";
import { desktopSession } from "../desktop/client";
import { tripAgent } from "../egress/sync";
import { cancelAgentRuns } from "../jobs/control";
import type { CrewPorts } from "./halt";

type Database = Awaited<ReturnType<typeof getDatabase>>;

// TASK-052. The production side of the kill switches. Each step is independent and time-bounded by haltAgent; nothing
// here waits on the job queue, and the pause is one direct owner-scoped UPDATE with its own 2 s lock timeout.
export function createKillSwitchPorts(database: Database): CrewPorts {
  return {
    async latchEgress(ownerId, agentId) { await tripAgent(database, ownerId, agentId); },
    cancelRuns(ownerId, agentId) { return cancelAgentRuns(ownerId, agentId); },
    async markPaused(ownerId, agentId) {
      await database.transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL lock_timeout = '2s'`);
        await transaction.update(agents).set({ status: "paused", updatedAt: new Date() })
          .where(and(eq(agents.ownerId, ownerId), eq(agents.id, agentId)));
      });
    },
    async stopSession(ownerId, agentId) {
      const status = await desktopSession(agentId, ownerId, "session.stop");
      return status.state === "stopped";
    },
    async postCard(ownerId, agentId, text) {
      await appendAgentCard(database, ownerId, agentId, { card: { type: "message", text }, sourceTag: "system" });
    },
    async setCrewStopped(ownerId, at) {
      await database.update(owner).set({ crewStoppedAt: at }).where(eq(owner.ownerId, ownerId));
    },
    async listAgentIds(ownerId) {
      const rows = await database.select({ id: agents.id }).from(agents).where(eq(agents.ownerId, ownerId));
      return rows.map((row) => row.id);
    },
  };
}
