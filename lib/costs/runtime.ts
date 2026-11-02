import type { GenerateRequest, ProviderConnector, ProviderResult, ProviderUsage } from "../providers/types";
import { CostStopError, type CostCallContext, type RunCostSink } from "./types";

const ZERO: ProviderUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };

const errorOutcome = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : "provider_error";
};

async function record(costs: RunCostSink, call: CostCallContext, usage: ProviderUsage, outcome: string) {
  try {
    await costs.recordCall({
      providerId: call.providerId, model: call.model,
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens },
      outcome,
    });
  } catch (error) {
    if (error instanceof CostStopError) throw error;
    throw new CostStopError("cost_error");
  }
}

async function trackedCall(
  costs: RunCostSink, call: CostCallContext, work: () => Promise<ProviderResult>,
): Promise<ProviderResult> {
  await costs.beforeCall(call);
  let result: ProviderResult;
  try {
    result = await work();
  } catch (error) {
    await record(costs, call, ZERO, errorOutcome(error));
    throw error;
  }
  await record(costs, call, result.usage, result.status);
  return result;
}

async function generateTracked(
  connector: ProviderConnector, costs: RunCostSink, call: CostCallContext, request: GenerateRequest,
): Promise<ProviderResult> {
  return trackedCall(costs, call, () => connector.generate(request));
}

// All Main/fallback/visual calls run through this wrapper so one connector call always means one ledger row.
export function createCostedConnector(connector: ProviderConnector, costs: RunCostSink, context: Omit<CostCallContext, "model">): ProviderConnector {
  return {
    kind: connector.kind,
    listModels: () => connector.listModels(),
    detectCapabilities: (model) => connector.detectCapabilities(model),
    generate: (request) => generateTracked(connector, costs, { ...context, model: request.model }, request),
    ...(connector.continueComputer ? {
      continueComputer: (continuation) => trackedCall(
        costs, { ...context, model: continuation.request.model },
        () => connector.continueComputer!(continuation),
      ),
    } : {}),
  };
}
