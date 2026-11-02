import "server-only";

import type { getDatabase } from "../../db/client";
import { createChatRunPorts } from "../agent/chat-run";
import { runTask } from "../agent/step-loop";
import { appendAgentCard, appendOutboxFiles } from "../chat/data";
import { loadRunExport } from "../receipts/store";
import type { ReplayResult } from "../replay/runner";
import { maybeHeal, type HealPorts, type HealScript } from "./heal";

type Database = Awaited<ReturnType<typeof getDatabase>>;

// TASK-044. Production wiring for a self-heal repair: the same model/desktop/receipt/budget path as a chat run, plus the
// owner-scoped run export that proves the repair.
export function createHealPorts(database: Database): HealPorts {
  const chat = createChatRunPorts(database);
  return {
    prepare: (ownerId, agentId) => chat.prepare(ownerId, agentId, { meta: { trigger: "heal", label: "Self-heal repair" } }),
    run: (deps) => runTask(deps),
    loadExport: (ownerId, runId) => loadRunExport(database, ownerId, runId),
    async postCard(ownerId, agentId, card, runId) {
      await appendAgentCard(database, ownerId, agentId, { card, sourceTag: "agent", ...(runId ? { runId } : {}) });
    },
    async fileDelivered(ownerId, agentId, file) { await appendOutboxFiles(database, ownerId, agentId, [file]); },
  };
}

// Fire-and-forget entry used by the replay ports. The replay has already released its agent lock.
export async function startHeal(
  database: Database, ownerId: string, script: HealScript, result: ReplayResult, replayRunId: string | null,
): Promise<void> {
  await maybeHeal(database, ownerId, script, result, replayRunId, createHealPorts(database)).catch(() => undefined);
}
