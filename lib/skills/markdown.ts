import "server-only";
import type { SkillModelDraft, SkillSource } from "./schema";

const yaml = (value: string) => JSON.stringify(value);

export function learnedFrom(source: SkillSource): string {
  return source === "video" ? "Learned from video + steps" : "Learned from steps + screenshots";
}

export function renderSkillMarkdown(draft: SkillModelDraft, source: SkillSource): string {
  const inputs = draft.inputs.length
    ? draft.inputs.map((input) => `- **${input.name}**${input.secret ? " (secret)" : ""}: ${input.description}`).join("\n")
    : "None.";
  const steps = draft.steps.map((step, index) => [
    `### ${index + 1}. ${step.instruction}`,
    step.input ? `- Input: ${step.input}` : null,
    `- Check: ${step.postcondition}`,
    `- Reference: step-${index + 1}.png`,
  ].filter(Boolean).join("\n")).join("\n\n");
  return [
    "---",
    `name: ${yaml(draft.name)}`,
    `description: ${yaml(draft.description)}`,
    "---",
    `# ${draft.name}`,
    learnedFrom(source),
    "## Inputs",
    inputs,
    "## Steps",
    steps,
    "",
  ].join("\n");
}
