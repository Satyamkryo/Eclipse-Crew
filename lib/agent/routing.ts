import "server-only";
import type { StepSummary } from "./context";

// TASK-027. Fixed routing never leaves the Main model. Auto routing switches to the hard-step model only when the
// Main model is struggling, at most MAX_HARD_TURNS times per run, and stops for good after the first hard-model failure.
export const MAX_HARD_TURNS = 5;

export type RouteKind = "main" | "hard" | "fallback";

// Results that mean the previous turn did not work.
const FAILED = new Set<StepSummary["result"]>(["invalid_output", "target_not_found", "failed"]);

export interface RouteInput {
  main: string;
  // Present only when the owner saved Auto routing with a hard-step model.
  hard?: string | null;
  // Set after the first hard-model error in this run.
  hardDisabled: boolean;
  hardTurns: number;
  // Result of the previous turn, if any, and how many times in a row the same intent has now been chosen.
  lastResult?: StepSummary["result"];
  repeats: number;
}

export function pickRoute(input: RouteInput): { model: string; kind: "main" | "hard" } {
  const struggling = (input.lastResult !== undefined && FAILED.has(input.lastResult)) || input.repeats >= 2;
  if (input.hard && !input.hardDisabled && input.hardTurns < MAX_HARD_TURNS && struggling) return { model: input.hard, kind: "hard" };
  return { model: input.main, kind: "main" };
}

// Short name shown with each step. Unknown models show their own id.
export function labelFor(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id.startsWith("muse-spark")) return id.endsWith("-contributor") ? "Muse Spark (Contributor)" : "Muse Spark";
  if (id.startsWith("muse-wonder")) return "Muse Wonder";
  return modelId;
}
