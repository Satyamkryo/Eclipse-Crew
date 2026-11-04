import "server-only";

// TASK-042. Runs live in the app process, so Cancel can only reach a run this process still holds. The registry is on
// globalThis because chat runs and replays start from different route bundles and must share one map.
export interface RunControl { signal: AbortSignal; done: () => void; cancel: () => void }

interface ActiveRun { controller: AbortController; ownerId: string; agentId: string }

const KEY = Symbol.for("eclipse-crew.active-runs");
const activeRuns: Map<string, ActiveRun> = ((globalThis as Record<symbol, unknown>)[KEY] ??= new Map()) as Map<string, ActiveRun>;

export function registerRun(runId: string, ownerId: string, agentId: string): RunControl {
  const controller = new AbortController();
  const entry: ActiveRun = { controller, ownerId, agentId };
  activeRuns.set(runId, entry);
  let released = false;
  return {
    signal: controller.signal,
    cancel: () => { if (!controller.signal.aborted) controller.abort("owner"); },
    done: () => {
      if (released) return;
      released = true;
      if (activeRuns.get(runId) === entry) activeRuns.delete(runId);
    },
  };
}

// A run of another owner and an unknown run both behave as "not running"; the route checks ownership first.
export function cancelRun(ownerId: string, runId: string): "cancelled" | "not_running" {
  const entry = activeRuns.get(runId);
  if (!entry || entry.ownerId !== ownerId || entry.controller.signal.aborted) return "not_running";
  entry.controller.abort("owner");
  return "cancelled";
}

export function isRunActive(ownerId: string, runId: string): boolean {
  const entry = activeRuns.get(runId);
  return Boolean(entry && entry.ownerId === ownerId && !entry.controller.signal.aborted);
}

// TASK-047. A trip stops every live run of one agent except the run that detected it (that run is already stopping).
export function cancelAgentRuns(ownerId: string, agentId: string, options: { except?: string } = {}): number {
  let cancelled = 0;
  for (const [runId, entry] of activeRuns) {
    if (entry.ownerId !== ownerId || entry.agentId !== agentId || runId === options.except) continue;
    if (entry.controller.signal.aborted) continue;
    entry.controller.abort("security");
    cancelled += 1;
  }
  return cancelled;
}

export function activeRunAgent(runId: string): string | null {
  return activeRuns.get(runId)?.agentId ?? null;
}
