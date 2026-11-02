export interface DiffLine { type: "same" | "add" | "remove"; text: string }

const MAX_LINES = 400;

function toLines(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [
    `Title: ${String(record.title ?? "")}`,
    `Body: ${String(record.body ?? "")}`,
    `Pinned: ${record.pinned === true ? "yes" : "no"}`,
    `Status: ${String(record.status ?? "")}`,
    `Scope: ${String(record.scope ?? "")}`,
  ].slice(0, MAX_LINES);
}

// Bounded line diff for the History view. Small documents make the quadratic table safe; anything larger is truncated.
export function diffSnapshots(before: unknown, after: unknown): DiffLine[] {
  const left = toLines(before);
  const right = toLines(after);
  const rows = left.length + 1;
  const cols = right.length + 1;
  const table = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { result.push({ type: "same", text: left[i] }); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) { result.push({ type: "remove", text: left[i] }); i++; }
    else { result.push({ type: "add", text: right[j] }); j++; }
    if (result.length >= MAX_LINES) break;
  }
  while (i < left.length && result.length < MAX_LINES) result.push({ type: "remove", text: left[i++] });
  while (j < right.length && result.length < MAX_LINES) result.push({ type: "add", text: right[j++] });
  return result;
}
