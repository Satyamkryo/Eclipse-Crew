import { createHash } from "node:crypto";

import type { McpTool } from "./schema";

// TASK-072. A version pin for a remote server: the owner confirms this hash, and a later session must match it.
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortKeys(record[key])]));
  }
  return value;
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0)!);
  const b = Array.from(right, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function canonicalTool(tool: McpTool): string {
  return JSON.stringify({
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema ? sortKeys(tool.inputSchema) : null,
    annotations: tool.annotations ? sortKeys(tool.annotations) : null,
  });
}

export function canonicalTools(tools: McpTool[]): string {
  return [...tools].sort((left, right) => compareCodePoints(left.name, right.name)).map(canonicalTool).join("\n");
}

export function toolsHash(tools: McpTool[]): string {
  return createHash("sha256").update(canonicalTools(tools), "utf8").digest("hex");
}

export interface ToolDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export function diffTools(pinned: McpTool[], live: McpTool[]): ToolDiff {
  const before = new Map(pinned.map((tool) => [tool.name, canonicalTool(tool)]));
  const after = new Map(live.map((tool) => [tool.name, canonicalTool(tool)]));
  const added = [...after.keys()].filter((name) => !before.has(name)).sort();
  const removed = [...before.keys()].filter((name) => !after.has(name)).sort();
  const changed = [...after.keys()].filter((name) => before.has(name) && before.get(name) !== after.get(name)).sort();
  return { added, removed, changed };
}
