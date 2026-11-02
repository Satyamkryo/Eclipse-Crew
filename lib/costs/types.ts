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
}

export interface RunCostSink {
  beforeCall(call: CostCallContext): Promise<void>;
  recordCall(call: CostCallResult): Promise<void>;
  totalMicroUsd(): number;
}
