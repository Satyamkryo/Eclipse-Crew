import "server-only";

import type { HelperResult, HelperStatus } from "./context";
import type { RunDeps, RunResult } from "./step-loop";

// TASK-076. Screenless helpers: at most three per parent run, one level deep, never more access than the parent.
export const SUBAGENT_LIMIT = 3;
export const SUBAGENT_TASK_MAX = 1000;
export const SUBAGENT_TOOLS_MAX = 10;
export const SUBAGENT_FINISH_WAIT_MS = 60_000;
export const SUBAGENT_RESULT_MAX = 4000;
export const SCREENLESS_ACTIONS = ["tool_call", "read_document", "search_document", "search_history", "get_time", "finish"] as const;

export type SpawnRefusal = "no_tools" | "tool_not_granted" | "duplicate_task" | "subagent_limit" | "nested_spawn" | "invalid_task";

export interface SpawnInput {
  task: string;
  tools: readonly string[];
  parentTools: readonly string[];
  existingTasks: readonly string[];
  count: number;
  allowSpawn: boolean;
}

// A tool is granted by exact name, or by a server wildcard (`server.*`) for a pinned MCP server. A helper can never
// name a tool the parent could not use itself.
export function toolGranted(tool: string, parentTools: readonly string[]): boolean {
  if (parentTools.includes(tool)) return true;
  const dot = tool.indexOf(".");
  if (dot > 0) {
    const server = tool.slice(0, dot);
    return parentTools.includes(`${server}.*`);
  }
  return false;
}

export function validateSpawn(input: SpawnInput): { ok: true } | { ok: false; code: SpawnRefusal } {
  if (!input.allowSpawn) return { ok: false, code: "nested_spawn" };
  const task = input.task.trim();
  if (!task || [...task].length > SUBAGENT_TASK_MAX || /[\u0000-\u001f\u007f]/.test(input.task)) return { ok: false, code: "invalid_task" };
  if (!input.tools.length) return { ok: false, code: "no_tools" };
  if (input.tools.length > SUBAGENT_TOOLS_MAX) return { ok: false, code: "tool_not_granted" };
  if (input.tools.some((tool) => !toolGranted(tool.trim(), input.parentTools))) return { ok: false, code: "tool_not_granted" };
  if (input.existingTasks.some((existing) => existing.trim() === task)) return { ok: false, code: "duplicate_task" };
  if (input.count >= SUBAGENT_LIMIT) return { ok: false, code: "subagent_limit" };
  return { ok: true };
}

export interface SubagentLimits { maxSteps: number; maxTokens: number; maxWallClockMs: number }
// Each helper gets 20% of the parent's actual limits, never more.
export function subagentLimits(parent: { maxSteps: number; maxTokens: number; maxWallClockMs: number }): SubagentLimits {
  return {
    maxSteps: Math.max(1, Math.floor(parent.maxSteps * 0.2)),
    maxTokens: Math.max(1, Math.floor(parent.maxTokens * 0.2)),
    maxWallClockMs: Math.max(1_000, Math.floor(parent.maxWallClockMs * 0.2)),
  };
}
export interface ChildBuildInput {
  label: string;
  task: string;
  tools: readonly string[];
  index: number;
  parentStep: number;
  limits: SubagentLimits;
  signal: AbortSignal;
}
export type ChildBuilder = (input: ChildBuildInput) => Promise<RunDeps>;

interface Helper {
  label: string;
  task: string;
  tools: readonly string[];
  state: HelperStatus["state"];
  controller: AbortController;
  promise: Promise<void>;
  outcome?: string;
  summary?: string;
}

export interface SubagentManager {
  spawn(input: { task: string; tools: readonly string[]; parentStep: number; limits: SubagentLimits; parentTools: readonly string[]; allowSpawn: boolean }):
    { ok: true; label: string } | { ok: false; code: SpawnRefusal };
  status(): HelperStatus[];
  results(): HelperResult[];
  count(): number;
  waitForIdle(ms: number): Promise<void>;
  cancelAll(): void;
}

// Runs helpers concurrently while the parent keeps its screen. Each helper is its own signed run; its final answer
// returns to the parent as data and never to the owner as a card.
export function createSubagentManager(options: {
  buildChild: ChildBuilder;
  run?: (deps: RunDeps) => Promise<RunResult>;
}): SubagentManager {
  const run = options.run;
  const helpers: Helper[] = [];
  const failedResult = (helper: Helper): HelperResult => ({
    label: helper.label, task: helper.task, outcome: helper.outcome ?? "failed",
    summary: (helper.summary ?? "").slice(0, SUBAGENT_RESULT_MAX),
  });

  return {
    spawn(input) {
      const check = validateSpawn({
        task: input.task, tools: input.tools, parentTools: input.parentTools,
        existingTasks: helpers.map((helper) => helper.task), count: helpers.length, allowSpawn: input.allowSpawn,
      });
      if (!check.ok) return { ok: false, code: check.code };
      const index = helpers.length + 1;
      const label = `Helper ${index}`;
      const controller = new AbortController();
      const helper: Helper = { label, task: input.task.trim(), tools: input.tools, state: "running", controller, promise: Promise.resolve() };
      helpers.push(helper);
      let depsRef: RunDeps | undefined;
      helper.promise = (async () => {
        try {
          const deps = await options.buildChild({
            label, task: helper.task, tools: helper.tools, index, parentStep: input.parentStep, limits: input.limits, signal: controller.signal,
          });
          depsRef = deps;
          const depsWithSignal = controller.signal.aborted ? deps : { ...deps, signal: controller.signal };
          if (controller.signal.aborted) { helper.outcome = "aborted"; helper.state = "stopped"; return; }
          const result = run ? await run(depsWithSignal) : await (await import("./step-loop")).runTask(depsWithSignal);
          helper.outcome = result.outcome;
          helper.summary = result.summary ?? (result.finalCard?.type === "message" ? result.finalCard.text : "");
          helper.state = result.outcome === "finished" ? "finished" : "stopped";
        } catch {
          helper.outcome = "failed";
          helper.state = "stopped";
        } finally {
          // A helper's tool sessions belong to this helper only.
          try { await depsRef?.tools?.close?.(); } catch { /* nothing more to release */ }
        }
      })();
      return { ok: true, label };
    },
    status() {
      return helpers.map((helper) => ({ label: helper.label, state: helper.state, task: helper.task }));
    },
    results() {
      return helpers.filter((helper) => helper.state !== "running").map(failedResult);
    },
    count() { return helpers.length; },
    async waitForIdle(ms) {
      const running = helpers.filter((helper) => helper.state === "running").map((helper) => helper.promise);
      if (!running.length) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(running),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, ms)); }),
      ]);
      if (timer) clearTimeout(timer);
    },
    cancelAll() {
      for (const helper of helpers) if (helper.state === "running") helper.controller.abort("owner");
    },
  };
}
