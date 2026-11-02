import type { ApprovalDecision } from "./types";

// TASK-050. A run waits in-process for its owner's answer. The map lives on globalThis because the step-loop and the
// decision route can load different module instances in dev, and both must see the same waiter.
export type WaiterAnswer = ApprovalDecision | "timeout" | "aborted";
type Waiter = (answer: WaiterAnswer) => void;

const KEY = Symbol.for("eclipse-crew.approval-waiters");
const waiters: Map<string, Waiter> = ((globalThis as Record<symbol, unknown>)[KEY] ??= new Map()) as Map<string, Waiter>;

export function waitForDecision(id: string, signal: AbortSignal | undefined, ms: number): Promise<WaiterAnswer> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (answer: WaiterAnswer) => {
      if (done) return;
      done = true;
      if (waiters.get(id) === waiter) waiters.delete(id);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(answer);
    };
    const waiter: Waiter = (answer) => finish(answer);
    waiters.set(id, waiter);
    const timer = setTimeout(() => finish("timeout"), Math.max(1, ms));
    timer.unref?.();
    const onAbort = () => finish("aborted");
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function resolveDecision(id: string, decision: ApprovalDecision): boolean {
  const waiter = waiters.get(id);
  if (!waiter) return false;
  waiter(decision);
  return true;
}

export function hasWaiter(id: string): boolean {
  return waiters.has(id);
}
