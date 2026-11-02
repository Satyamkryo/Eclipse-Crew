import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { runs, steps } from "../../db/schema";
import { buildHeader, buildReceipt, buildRunExport, sealRun, type RunExport } from "./chain.mjs";
import type { ReceiptInput, ReceiptSink, ReceiptUsage } from "./fields";
import type { ReceiptSigner } from "./signer";

type Database = Awaited<ReturnType<typeof getDatabase>>;

export interface RecorderOptions {
  database: Database;
  ownerId: string;
  agentId: string;
  agentName: string;
  task: string;
  signer: ReceiptSigner;
  runId?: string;
  // TASK-043: the signed header names the original run and checkpoint. Only branches carry it.
  branch?: { runId: string; step: number };
  // TASK-042: called after the run row exists, so display metadata can point at it. A failure here never stops a run.
  onBegin?: () => Promise<void>;
  now?: () => Date;
}

// Writes one run's proof to Postgres. Steps are written one at a time by the single run of this agent, so the in-memory
// head hash is the only chain state. A failed write leaves the head unchanged and throws; the step loop then stops.
export function createReceiptRecorder(options: RecorderOptions): ReceiptSink {
  const { database, ownerId, agentId, signer } = options;
  const runId = options.runId ?? randomUUID();
  const now = options.now ?? (() => new Date());
  let started: { headerHash: string } | null = null;
  let head = "";
  let count = 0;
  let sealed = false;

  return {
    runId,
    async begin() {
      if (started) throw new Error("run already started");
      if (options.branch && options.branch.runId === runId) throw new Error("invalid_branch");
      const startedAt = now().toISOString();
      const header = buildHeader({ runId, agentId, agentName: options.agentName, task: options.task, startedAt, keyId: signer.keyId,
        ...(options.branch ? { branchOf: options.branch.runId, branchAt: options.branch.step } : {}) });
      await database.insert(runs).values({
        id: runId, ownerId, agentId, branchOf: options.branch?.runId ?? null,
        headerJson: header.text, headerHash: header.hash, keyId: signer.keyId,
        publicKey: signer.publicKey, startedAt: new Date(startedAt),
      });
      started = { headerHash: header.hash };
      head = header.hash;
      if (options.onBegin) await options.onBegin().catch(() => undefined);
    },
    async step(input: ReceiptInput) {
      if (!started || sealed) throw new Error("run is not open");
      if (input.idx !== count + 1) throw new Error("receipt index out of order");
      const receipt = buildReceipt({ run_id: runId, agent_id: agentId, at: now().toISOString(), ...input }, head);
      await database.insert(steps).values({
        id: randomUUID(), ownerId, runId, idx: input.idx, receiptJson: receipt.text, receiptHash: receipt.hash, prevHash: head,
      });
      head = receipt.hash;
      count += 1;
    },
    async seal(status: string, usage: ReceiptUsage) {
      if (!started || sealed) throw new Error("run is not open");
      const endedAt = now().toISOString();
      const signature = sealRun(signer.privateKey, {
        runId, headerHash: started.headerHash, stepCount: count, headHash: head, status, endedAt, usage,
      });
      const updated = await database.update(runs)
        .set({ status, endedAt: new Date(endedAt), stepCount: count, headHash: head, usage, signature })
        .where(and(eq(runs.id, runId), eq(runs.ownerId, ownerId), isNull(runs.signature)))
        .returning({ id: runs.id });
      if (updated.length !== 1) throw new Error("run was already sealed");
      sealed = true;
    },
  };
}

// The export for one run, scoped to its owner. null when the run does not exist or belongs to someone else.
export async function loadRunExport(database: Database, ownerId: string, runId: string): Promise<RunExport | null> {
  const found = await database.select().from(runs).where(and(eq(runs.id, runId), eq(runs.ownerId, ownerId))).limit(1);
  const run = found[0];
  if (!run) return null;
  const rows = await database.select().from(steps)
    .where(and(eq(steps.runId, runId), eq(steps.ownerId, ownerId))).orderBy(asc(steps.idx));
  const usage = run.usage as ReceiptUsage | null;
  return buildRunExport({
    runId: run.id, headerText: run.headerJson, headerHash: run.headerHash, keyId: run.keyId, publicKey: run.publicKey,
    seal: run.signature && run.endedAt && run.stepCount !== null && run.headHash && usage ? {
      status: run.status, endedAt: run.endedAt.toISOString(), stepCount: run.stepCount, headHash: run.headHash, usage,
      signature: run.signature,
    } : null,
  }, rows.map((row) => ({ idx: row.idx, receiptText: row.receiptJson, receiptHash: row.receiptHash, prevHash: row.prevHash })));
}
