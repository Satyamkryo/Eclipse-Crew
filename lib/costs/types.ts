import type { PriceProviderKind, TokenUsage } from "./pricing";

export type BudgetCard = {
  type: "budget_warning" | "budget_paused";
  period: "daily" | "monthly";
  spentMicroUsd: number;
  limitCents: number;
};

export type CostStopCode = "budget_paused" | "price_required" | "cost_error";

export class CostStopError extends Error {
  constructor(public code: CostStopCode, public card?: BudgetCard) {
    super(code);
    this.name = "CostStopError";
  }
}

export interface CostCallContext {
  providerId: string;
  kind: PriceProviderKind;
  baseUrl: string | null;
  model: string;
  images?: number;
}

export interface CostCallResult {
  providerId: string;
  model: string;
  usage: TokenUsage;
  outcome: string;
  images?: number;
  // TASK-079. Whole milliseconds of audio attributed to a run-scoped call row.
  audioDurationMs?: number;
}

// TASK-079. One conservative audio attempt, charged before dispatch with the shared call allocator.
export interface AudioCallContext {
  providerId: string;
  kind: PriceProviderKind;
  baseUrl: string | null;
  model: string;
  durationMs: number;
  // Stable for a retried step; an absent key is a new attempt.
  key?: string;
}
export interface AudioReservation { duplicate: boolean; costMicroUsd: number; callIndex: number }

export interface RunCostSink {
  beforeCall(call: CostCallContext): Promise<void>;
  recordCall(call: CostCallResult): Promise<void>;
  // Reserves and records one attempted-duration charge before any paid audio request. A duplicate key never resends.
  reserveAudio(call: AudioCallContext): Promise<AudioReservation>;
  totalMicroUsd(): number;
}
