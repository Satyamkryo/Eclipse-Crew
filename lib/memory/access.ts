import type { MemoryDocument, MemoryEntryView, MemoryScope } from "./schema";

export interface ReadableEntry {
  doc: MemoryDocument;
  scope: MemoryScope;
  agentId: string | null;
  visibleTo: string[];
}

// TASK-053. The only read rule. Default deny: the reader's saved memory scopes must include the entry's scope.
export function canRead(entry: ReadableEntry, readerAgentId: string, policyScopes: readonly string[]): boolean {
  const allowed = (scope: MemoryScope) => policyScopes.includes(scope);
  if (entry.doc === "user") return entry.scope === "global" && allowed("global");
  if (entry.doc === "memory") return entry.agentId === readerAgentId && entry.scope === "agent" && allowed("agent");
  if (entry.doc === "private") {
    return entry.scope === "private" && allowed("private") &&
      (entry.agentId === readerAgentId || entry.visibleTo.includes(readerAgentId));
  }
  return false;
}

export function readableEntries<T extends MemoryEntryView>(
  entries: readonly T[], readerAgentId: string, policyScopes: readonly string[],
): T[] {
  return entries.filter((entry) => canRead(entry, readerAgentId, policyScopes));
}
