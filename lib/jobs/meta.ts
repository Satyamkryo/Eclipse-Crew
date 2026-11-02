import "server-only";

import { z } from "zod";

import type { getDatabase } from "../../db/client";
import { runMeta } from "../../db/schema";

type Database = Awaited<ReturnType<typeof getDatabase>>;

const inputSchema = z.object({
  runId: z.string().uuid(),
  ownerId: z.string().uuid(),
  agentId: z.string().uuid(),
  trigger: z.enum(["chat", "run_now", "schedule", "replay", "branch", "heal"]),
  routineId: z.string().uuid().optional(),
  executionId: z.string().uuid().optional(),
  replayScriptId: z.string().uuid().optional(),
  retryOf: z.string().uuid().optional(),
  label: z.string().max(500).optional(),
}).strict();
export type RunMetaInput = z.input<typeof inputSchema>;

export function cleanLabel(value: string | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return cleaned || null;
}

// Written once, right after a run id exists. Metadata is for the Jobs page only: a failed write never stops a run, and a
// duplicate key (the same launcher called twice) leaves the first row alone.
export async function recordRunMeta(database: Database, input: RunMetaInput): Promise<void> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return;
  try {
    await database.insert(runMeta).values({
      runId: parsed.data.runId,
      ownerId: parsed.data.ownerId,
      agentId: parsed.data.agentId,
      trigger: parsed.data.trigger,
      routineId: parsed.data.routineId ?? null,
      executionId: parsed.data.executionId ?? null,
      replayScriptId: parsed.data.replayScriptId ?? null,
      retryOf: parsed.data.retryOf ?? null,
      label: cleanLabel(parsed.data.label),
    }).onConflictDoNothing({ target: runMeta.runId });
  } catch { /* metadata never stops a run */ }
}
