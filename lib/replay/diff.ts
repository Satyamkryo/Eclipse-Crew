import type { ReplayStep } from "./script";
import { stepText } from "./view";

// TASK-044. A small line diff over replay steps for the approval view. Pure: no server import, no model text. A step is
// the same only when every field except its position matches, so a changed expected result shows as removed + added.

export type DiffKind = "same" | "removed" | "added";

export interface DiffRow {
  kind: DiffKind;
  text: string;
  expect: string;
  oldIdx: number | null;
  newIdx: number | null;
}

const keyOf = (step: ReplayStep): string => JSON.stringify([
  step.action,
  step.action === "click" ? step.role : "",
  step.action === "click" ? step.name : "",
  step.action === "key" ? step.keys : "",
  step.action === "scroll" ? step.direction : "",
  step.action === "type" ? step.chars : 0,
  step.action === "deliver_file" ? step.from : "",
  step.action === "deliver_file" ? step.file : "",
  "expect" in step ? step.expect : "",
]);

const expectOf = (step: ReplayStep): string => ("expect" in step ? step.expect : "");

const row = (kind: DiffKind, step: ReplayStep, oldIdx: number | null, newIdx: number | null): DiffRow => ({
  kind, text: stepText(step), expect: expectOf(step), oldIdx, newIdx,
});

export function diffSteps(oldSteps: readonly ReplayStep[], newSteps: readonly ReplayStep[]): DiffRow[] {
  const before = oldSteps.map(keyOf);
  const after = newSteps.map(keyOf);
  const rows: Array<Uint16Array> = Array.from({ length: before.length + 1 }, () => new Uint16Array(after.length + 1));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      rows[i][j] = before[i] === after[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
    }
  }

  const diff: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      diff.push(row("same", oldSteps[i], oldSteps[i].idx, newSteps[j].idx));
      i += 1;
      j += 1;
    } else if (rows[i + 1][j] >= rows[i][j + 1]) {
      diff.push(row("removed", oldSteps[i], oldSteps[i].idx, null));
      i += 1;
    } else {
      diff.push(row("added", newSteps[j], null, newSteps[j].idx));
      j += 1;
    }
  }
  while (i < before.length) { diff.push(row("removed", oldSteps[i], oldSteps[i].idx, null)); i += 1; }
  while (j < after.length) { diff.push(row("added", newSteps[j], null, newSteps[j].idx)); j += 1; }
  return diff;
}

export const affectedCount = (rows: readonly DiffRow[]): number => rows.filter((row) => row.kind !== "same").length;
