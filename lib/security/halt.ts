import "server-only";

// TASK-052. Emergency stops. Each step is independent and time-bounded: a hanging desktop controller, a down egress
// proxy or a failed log must never stop the agent from being marked paused. Ports are injected so the routes, the
// tripwire and tests share one order without one of them owning the database.

export const HALT_STEPS = ["latch_egress", "cancel_runs", "pause", "stop_session", "card"] as const;
export type HaltStepName = (typeof HALT_STEPS)[number];

export interface HaltStepResult { step: HaltStepName; ok: boolean }
export interface HaltResult { ok: boolean; steps: HaltStepResult[] }

export interface HaltPorts {
  // The egress proxy refuses this agent (TASK-045).
  latchEgress(ownerId: string, agentId: string): Promise<unknown>;
  // In-process run cancellation (TASK-042/047).
  cancelRuns(ownerId: string, agentId: string): Promise<unknown> | unknown;
  // One direct UPDATE to status='paused'. It must not wait on the desktop or the queue.
  markPaused(ownerId: string, agentId: string): Promise<void>;
  // Best effort. Absent means the deployment has no desktop to stop.
  stopSession?(ownerId: string, agentId: string): Promise<unknown>;
  // One fixed message card. Absent means the caller posts its own card (the tripwire does).
  postCard?(ownerId: string, agentId: string, text: string): Promise<unknown>;
}

export interface HaltOptions {
  ownerId: string;
  agentId: string;
  reason?: "agent" | "crew";
  // Total time for all five steps. The route promises an answer within 5 s.
  budgetMs?: number;
}

export const HALT_BUDGET_MS = 4_500;
const AGENT_STOPPED = "Agent stopped. The desktop was asked to stop and the agent is paused.";
const CREW_STOPPED = "Agent stopped because the whole crew was stopped. The desktop was asked to stop and the agent is paused.";
const DESKTOP_NOT_STOPPED = " The desktop could not be stopped.";

function withinBudget<Value>(work: Promise<Value>, deadline: number): Promise<Value> {
  const left = deadline - Date.now();
  if (left <= 0) return Promise.reject(new Error("halt_timeout"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("halt_timeout")), left); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

// Order: latch the proxy, cancel live runs, mark paused, ask the desktop to stop, post one card. Later steps run even
// when an earlier one fails or hangs. `ok` means the pause landed, because that is what stops the next run.
export async function haltAgent(ports: HaltPorts, options: HaltOptions): Promise<HaltResult> {
  const { ownerId, agentId } = options;
  const budgetMs = options.budgetMs ?? HALT_BUDGET_MS;
  const overallDeadline = Date.now() + budgetMs;
  // Each step gets its own slice, so one hanging dependency cannot consume the budget of the steps after it.
  const stepBudget = Math.max(50, Math.floor(budgetMs / HALT_STEPS.length));
  const steps: HaltStepResult[] = [];
  const run = async <Value>(step: HaltStepName, work: () => Promise<Value> | Value): Promise<{ ok: boolean; value?: Value }> => {
    try {
      const value = await withinBudget(Promise.resolve().then(work), Math.min(overallDeadline, Date.now() + stepBudget));
      steps.push({ step, ok: true });
      return { ok: true, value };
    } catch {
      steps.push({ step, ok: false });
      return { ok: false };
    }
  };

  await run("latch_egress", () => ports.latchEgress(ownerId, agentId));
  await run("cancel_runs", () => ports.cancelRuns(ownerId, agentId));
  await run("pause", () => ports.markPaused(ownerId, agentId));
  let desktopStopped = true;
  if (ports.stopSession) {
    const stopped = await run("stop_session", () => ports.stopSession!(ownerId, agentId));
    desktopStopped = stopped.ok && stopped.value !== false;
  } else steps.push({ step: "stop_session", ok: true });

  const text = `${options.reason === "crew" ? CREW_STOPPED : AGENT_STOPPED}${desktopStopped ? "" : DESKTOP_NOT_STOPPED}`;
  if (ports.postCard) await run("card", () => ports.postCard!(ownerId, agentId, text));
  else steps.push({ step: "card", ok: true });

  return { ok: steps.find((step) => step.step === "pause")?.ok === true, steps };
}

export interface CrewPorts extends HaltPorts {
  // owner.crew_stopped_at: set first, cleared by resume. While set, no run may prepare.
  setCrewStopped(ownerId: string, at: Date | null): Promise<void>;
  listAgentIds(ownerId: string): Promise<string[]>;
}

export interface CrewStopResult {
  ok: boolean;
  agents: { agentId: string; result: HaltResult }[];
}

// Stop crew sets the gate before touching any agent, so a run that starts mid-stop is still refused. Every agent is
// halted independently; one failing agent does not stop the others. Resume clears only the gate: agents stay paused.
export async function stopCrew(ports: CrewPorts, ownerId: string, now: () => Date = () => new Date()): Promise<CrewStopResult> {
  try { await ports.setCrewStopped(ownerId, now()); }
  catch { return { ok: false, agents: [] }; }

  let agentIds: string[] = [];
  try { agentIds = await ports.listAgentIds(ownerId); } catch { /* the gate is already set; nothing else to halt */ }
  const settled = await Promise.allSettled(agentIds.map((agentId) => haltAgent(ports, { ownerId, agentId, reason: "crew" })));
  const agents = settled.map((outcome, index) => ({
    agentId: agentIds[index],
    result: outcome.status === "fulfilled" ? outcome.value : { ok: false, steps: [] },
  }));
  return { ok: true, agents };
}

export async function resumeCrew(ports: Pick<CrewPorts, "setCrewStopped">, ownerId: string): Promise<void> {
  await ports.setCrewStopped(ownerId, null);
}
