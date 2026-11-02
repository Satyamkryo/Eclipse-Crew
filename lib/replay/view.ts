// TASK-041/TASK-044. What the History tab shows about a saved replay. No server-only import: client components share these
// types and labels. Names inside steps came from page text, so they are untrusted display text.
export interface ReplayStepView { idx: number; text: string; needsText: boolean }
export interface ReplayScriptView {
  id: string;
  name: string;
  stepCount: number;
  createdAt: string;
  sourceRunId: string;
  version: number;
  pendingProposalId: string | null;
  steps: ReplayStepView[];
}
export type CompileCodeView =
  | "no_steps" | "too_many_steps" | "receipt_unreadable" | "step_not_verified" | "step_not_replayable"
  | "postcondition_not_structural" | "control_unknown" | "run_not_verified" | "chain_invalid";

type StepLike = { idx: number; action: string; role?: string; name?: string; keys?: string; direction?: string; file?: string; chars?: number };

export function stepText(step: StepLike): string {
  switch (step.action) {
    case "click": return `Click ${step.role ?? "control"} “${step.name ?? ""}”`;
    case "type": return "Type your text";
    case "key": return `Press ${step.keys ?? ""}`;
    case "scroll": return `Scroll ${step.direction ?? "down"}`;
    case "wait": return "Wait";
    case "deliver_file": return `Send file ${step.file ?? ""}`;
    default: return "Step";
  }
}

export const toStepViews = (steps: readonly StepLike[]): ReplayStepView[] =>
  steps.map((step) => ({ idx: step.idx, text: stepText(step), needsText: step.action === "type" }));

export const REFUSAL_TEXT: Record<CompileCodeView, string> = {
  no_steps: "This run took no desktop steps.",
  too_many_steps: "This run has more than 20 steps.",
  receipt_unreadable: "A step's receipt could not be read.",
  step_not_verified: "A step was not verified.",
  step_not_replayable: "A step can't be replayed (for example reading a document).",
  postcondition_not_structural: "A step's expected result can only be judged by a model.",
  control_unknown: "A click did not record which control it used.",
  run_not_verified: "Only a finished run with every step verified can be saved.",
  chain_invalid: "The run's proof chain did not verify.",
};
