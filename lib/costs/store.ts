import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";

import type { getDatabase } from "../../db/client";
import { agents, costEntries, modelPrices, modelRoles, owner, providers, runs } from "../../db/schema";
import {
  budgetPeriods, calculateCostMicroUsd, evaluateBudget, isLocalBaseUrl, resolveModelPrice,
  type BudgetPeriod, type ModelPriceRates, type PriceProviderKind,
} from "./pricing";
import { CostStopError, type AudioCallContext, type AudioReservation, type BudgetCard, type RunCostSink } from "./types";

type Database = Awaited<ReturnType<typeof getDatabase>>;
type ReadStore = Pick<Database, "select">;
type UpdateStore = Pick<Database, "update">;

export type AttentionReason = "budget_warning" | "budget_paused" | "security_stop" | "approval_pending" | null;

export interface BudgetStatus {
  state: "ok" | "warning" | "paused";
  period: BudgetPeriod;
  attention: AttentionReason;
  daySpentMicroUsd: number;
  monthSpentMicroUsd: number;
  dailyLimitCents: number;
  monthlyLimitCents: number;
  card?: BudgetCard;
}

function toNumber(value: unknown): number {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new CostStopError("cost_error");
  return parsed;
}

function outcomeCode(value: unknown): string {
  return typeof value === "string" && /^[a-z_]{1,64}$/.test(value) ? value : "failed";
}

export async function readBudgetStatus(
  database: ReadStore, ownerId: string, agentId: string, now: Date,
): Promise<BudgetStatus> {
  const rows = await database.select({
    timezone: owner.timezone,
    dailyLimitCents: agents.dailyBudgetCents,
    monthlyLimitCents: agents.monthlyBudgetCents,
    attention: agents.attentionReason,
  }).from(agents).innerJoin(owner, eq(owner.id, agents.ownerId))
    .where(and(eq(agents.ownerId, ownerId), eq(agents.id, agentId))).limit(1);
  const row = rows[0];
  if (!row) throw new CostStopError("cost_error");
  const periods = budgetPeriods(now, row.timezone);
  const spent = await database.select({
    day: sql<string>`coalesce(sum(case when ${costEntries.createdAt} >= ${periods.dayStart} and ${costEntries.createdAt} < ${periods.dayEnd} then ${costEntries.costMicroUsd} else 0 end), 0)::text`,
    month: sql<string>`coalesce(sum(case when ${costEntries.createdAt} >= ${periods.monthStart} and ${costEntries.createdAt} < ${periods.monthEnd} then ${costEntries.costMicroUsd} else 0 end), 0)::text`,
  }).from(costEntries).where(and(eq(costEntries.ownerId, ownerId), eq(costEntries.agentId, agentId)));
  const daySpentMicroUsd = toNumber(spent[0]?.day);
  const monthSpentMicroUsd = toNumber(spent[0]?.month);
  const result = evaluateBudget({
    daySpentMicroUsd, monthSpentMicroUsd,
    dailyLimitCents: row.dailyLimitCents, monthlyLimitCents: row.monthlyLimitCents,
  });
  const spentMicroUsd = result.period === "daily" ? daySpentMicroUsd : monthSpentMicroUsd;
  const limitCents = result.period === "daily" ? row.dailyLimitCents : row.monthlyLimitCents;
  return {
    ...result, attention: row.attention as AttentionReason, daySpentMicroUsd, monthSpentMicroUsd,
    dailyLimitCents: row.dailyLimitCents, monthlyLimitCents: row.monthlyLimitCents,
    ...(result.state === "ok" ? {} : { card: {
      type: result.state === "paused" ? "budget_paused" as const : "budget_warning" as const,
      period: result.period, spentMicroUsd, limitCents,
    } }),
  };
}

export async function setAgentAttention(
  database: UpdateStore, ownerId: string, agentId: string, attention: Exclude<AttentionReason, null>,
  { pause = false }: { pause?: boolean } = {},
) {
  const updated = await database.update(agents).set({
    attentionReason: attention,
    ...(pause ? { status: "paused" } : {}),
    updatedAt: new Date(),
  }).where(and(eq(agents.ownerId, ownerId), eq(agents.id, agentId))).returning({ id: agents.id });
  if (!updated[0]) throw new CostStopError("cost_error");
}

export async function setApprovalAttention(database: UpdateStore, ownerId: string, agentId: string) {
  await database.update(agents).set({ attentionReason: "approval_pending", updatedAt: new Date() })
    .where(and(eq(agents.ownerId, ownerId), eq(agents.id, agentId),
      or(isNull(agents.attentionReason), eq(agents.attentionReason, "approval_pending"))));
}

export async function clearAgentAttention(
  database: UpdateStore, ownerId: string, agentId: string, expected?: Exclude<AttentionReason, null>,
) {
  await database.update(agents).set({ attentionReason: null, updatedAt: new Date() })
    .where(and(eq(agents.ownerId, ownerId), eq(agents.id, agentId),
      expected === undefined ? undefined : eq(agents.attentionReason, expected)));
}

export async function listAgentAttention(database: Database, ownerId: string) {
  return database.select({
    id: agents.id,
    attention: agents.attentionReason,
    updatedAt: agents.updatedAt,
  }).from(agents).where(eq(agents.ownerId, ownerId)).orderBy(asc(agents.name));
}

export async function priceFor(
  database: Database, ownerId: string, providerId: string, model: string,
): Promise<ModelPriceRates | null> {
  const rows = await database.select({
    kind: providers.kind,
    baseUrl: providers.baseUrl,
    input: modelPrices.inputMicroUsdPerMillion,
    cached: modelPrices.cachedMicroUsdPerMillion,
    output: modelPrices.outputMicroUsdPerMillion,
    image: modelPrices.imageMicroUsdPerThousand,
    audio: modelPrices.audioMicroUsdPerHour,
  }).from(providers).leftJoin(modelPrices, and(
    eq(modelPrices.ownerId, providers.ownerId),
    eq(modelPrices.providerId, providers.id),
    eq(modelPrices.model, model),
  )).where(and(eq(providers.ownerId, ownerId), eq(providers.id, providerId))).limit(1);
  const row = rows[0];
  if (!row) throw new CostStopError("cost_error");
  const override = row.input === null ? null : {
    inputMicroUsdPerMillion: toNumber(row.input),
    cachedMicroUsdPerMillion: toNumber(row.cached),
    outputMicroUsdPerMillion: toNumber(row.output),
    imageMicroUsdPerThousand: toNumber(row.image),
    audioMicroUsdPerHour: toNumber(row.audio),
  };
  return resolveModelPrice({
    kind: row.kind as PriceProviderKind, baseUrl: row.baseUrl, model, override,
  });
}

export function createRunCostSink(options: {
  database: Database;
  ownerId: string;
  agentId: string;
  runId: string;
  now?: () => Date;
  onWarning?: (card: BudgetCard) => Promise<void> | void;
}): RunCostSink {
  const { database, ownerId, agentId, runId } = options;
  const now = options.now ?? (() => new Date());
  const prices = new Map<string, ModelPriceRates>();
  const audioKeys = new Map<string, { costMicroUsd: number; callIndex: number }>();
  let callIndex = 0;
  let total = 0;
  let warned = false;

  return {
    async beforeCall(call) {
      const key = `${call.providerId}\0${call.model}`;
      const price = await priceFor(database, ownerId, call.providerId, call.model);
      if (!price) throw new CostStopError("price_required");
      prices.set(key, price);
      const budget = await readBudgetStatus(database, ownerId, agentId, now());
      if (budget.state === "ok" && budget.attention === "budget_warning") {
        await clearAgentAttention(database, ownerId, agentId);
      }
      if (budget.state === "paused" && budget.card) {
        await setAgentAttention(database, ownerId, agentId, "budget_paused", { pause: true });
        throw new CostStopError("budget_paused", budget.card);
      }
      if (budget.state === "warning" && budget.card) {
        await setAgentAttention(database, ownerId, agentId, "budget_warning");
        if (!warned) {
          warned = true;
          try { await options.onWarning?.(budget.card); } catch { /* the warning is advisory; the guard still applies */ }
        }
      }
    },

    async recordCall(call) {
      const key = `${call.providerId}\0${call.model}`;
      const price = prices.get(key);
      prices.delete(key);
      if (!price) throw new CostStopError("cost_error");
      const index = ++callIndex;
      let cost: number;
      try {
        cost = calculateCostMicroUsd(price, call.usage, { images: call.images, audioDurationMs: call.audioDurationMs ?? 0 });
      } catch {
        throw new CostStopError("cost_error");
      }
      const outcome = outcomeCode(call.outcome);
      try {
        const inserted = await database.insert(costEntries).values({
          id: randomUUID(),
          ownerId,
          runId,
          agentId,
          providerId: call.providerId,
          callIndex: index,
          model: call.model,
          tokensIn: call.usage.inputTokens,
          tokensOut: call.usage.outputTokens,
          tokensCached: call.usage.cachedInputTokens,
          audioDurationMs: call.audioDurationMs ?? 0,
          costMicroUsd: cost,
          outcome,
          idempotencyKey: `cost:${runId}:${index}`,
        }).onConflictDoNothing({ target: costEntries.idempotencyKey }).returning({ id: costEntries.id });
        if (inserted[0]) total += cost;
      } catch {
        throw new CostStopError("cost_error");
      }
      if (total > Number.MAX_SAFE_INTEGER) throw new CostStopError("cost_error");
    },

    async reserveAudio(call: AudioCallContext): Promise<AudioReservation> {
      if (!Number.isSafeInteger(call.durationMs) || call.durationMs < 1 || call.durationMs > 120000) throw new CostStopError("cost_error");
      const key = call.key ?? `${call.providerId}\0${call.model}\0${call.durationMs}\0${randomUUID()}`;
      const prior = audioKeys.get(key); if (prior) return { duplicate: true, ...prior };
      const priceKey = `${call.providerId}\0${call.model}`;
      await this.beforeCall({ providerId: call.providerId, kind: call.kind, baseUrl: call.baseUrl, model: call.model });
      const price = prices.get(priceKey); prices.delete(priceKey);
      if (!price || price.audioMicroUsdPerHour === undefined) throw new CostStopError("price_required");
      let cost: number;
      try { cost = calculateCostMicroUsd(price, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }, { audioDurationMs: call.durationMs }); }
      catch { throw new CostStopError("cost_error"); }
      const index = ++callIndex;
      try {
        const inserted = await database.insert(costEntries).values({
          id: randomUUID(), ownerId, runId, agentId, providerId: call.providerId, callIndex: index, model: call.model,
          tokensIn: 0, tokensOut: 0, tokensCached: 0, audioDurationMs: call.durationMs, costMicroUsd: cost,
          outcome: "asr_attempted", idempotencyKey: `cost:${runId}:${index}`,
        }).onConflictDoNothing({ target: costEntries.idempotencyKey }).returning({ id: costEntries.id });
        if (!inserted[0]) { const reservation = { duplicate: true, costMicroUsd: cost, callIndex: index }; audioKeys.set(key, reservation); return reservation; }
        total += cost;
      } catch { throw new CostStopError("cost_error"); }
      if (total > Number.MAX_SAFE_INTEGER) throw new CostStopError("cost_error");
      const reservation = { duplicate: false, costMicroUsd: cost, callIndex: index };
      audioKeys.set(key, { costMicroUsd: cost, callIndex: index });
      return reservation;
    },

    totalMicroUsd() { return total; },
  };
}

export async function upsertModelPrice(
  database: Database, ownerId: string, input: {
    providerId: string; model: string;
  } & ModelPriceRates,
) {
  const provider = await database.select({ id: providers.id }).from(providers)
    .where(and(eq(providers.ownerId, ownerId), eq(providers.id, input.providerId))).limit(1);
  if (!provider[0]) return false;
  await database.insert(modelPrices).values({
    id: randomUUID(), ownerId, providerId: input.providerId, model: input.model,
    inputMicroUsdPerMillion: input.inputMicroUsdPerMillion,
    cachedMicroUsdPerMillion: input.cachedMicroUsdPerMillion,
    outputMicroUsdPerMillion: input.outputMicroUsdPerMillion,
    imageMicroUsdPerThousand: input.imageMicroUsdPerThousand,
    audioMicroUsdPerHour: input.audioMicroUsdPerHour ?? 0,
  }).onConflictDoUpdate({
    target: [modelPrices.ownerId, modelPrices.providerId, modelPrices.model],
    set: {
      inputMicroUsdPerMillion: input.inputMicroUsdPerMillion,
      cachedMicroUsdPerMillion: input.cachedMicroUsdPerMillion,
      outputMicroUsdPerMillion: input.outputMicroUsdPerMillion,
      imageMicroUsdPerThousand: input.imageMicroUsdPerThousand,
      ...(input.audioMicroUsdPerHour === undefined ? {} : { audioMicroUsdPerHour: input.audioMicroUsdPerHour }),
      updatedAt: new Date(),
    },
  });
  return true;
}

export type PriceRow = {
  providerId: string;
  providerLabel: string;
  kind: PriceProviderKind;
  baseUrl: string | null;
  model: string;
  role: "main" | "hard" | "sam" | "custom" | null;
  price: ModelPriceRates | null;
  source: "default" | "override" | "local" | "unpriced";
};

export async function loadPriceRows(database: Database, ownerId: string): Promise<PriceRow[]> {
  const roleRows = await database.select({
    providerId: modelRoles.providerId,
    role: modelRoles.role,
    model: modelRoles.model,
    hardModel: modelRoles.hardModel,
    kind: providers.kind,
    baseUrl: providers.baseUrl,
  }).from(modelRoles).leftJoin(providers, and(
    eq(providers.ownerId, modelRoles.ownerId), eq(providers.id, modelRoles.providerId),
  )).where(eq(modelRoles.ownerId, ownerId));
  const overrides = await database.select().from(modelPrices).where(eq(modelPrices.ownerId, ownerId));
  const overrideMap = new Map(overrides.map((row) => [`${row.providerId}\0${row.model}`, row]));
  const entries: Array<Omit<PriceRow, "price" | "source" | "providerLabel">> = [];
  for (const role of roleRows) {
    if (!role.providerId || !role.kind) continue;
    for (const [model, label] of [[role.model, role.role], [role.hardModel, "hard"] as const]) {
      if (model) entries.push({
        providerId: role.providerId, kind: role.kind as PriceProviderKind, baseUrl: role.baseUrl, model,
        role: label as PriceRow["role"],
      });
    }
  }
  for (const row of overrides) {
    const found = roleRows.find((role) => role.providerId === row.providerId);
    entries.push({
      providerId: row.providerId, kind: found?.kind as PriceProviderKind ?? "openai-compatible",
      baseUrl: found?.baseUrl ?? null, model: row.model, role: "custom",
    });
  }
  for (const role of roleRows) {
    if (role.role === "main" && role.kind === "meta" && role.providerId) entries.push({ providerId: role.providerId, kind: "meta", baseUrl: null, model: "muse-voice-transcribe-1.0", role: null });
  }
  const seen = new Set<string>();
  return entries.flatMap((entry) => {
    const key = `${entry.providerId}\0${entry.model}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const row = overrideMap.get(key);
    const override = row ? {
      inputMicroUsdPerMillion: row.inputMicroUsdPerMillion,
      cachedMicroUsdPerMillion: row.cachedMicroUsdPerMillion,
      outputMicroUsdPerMillion: row.outputMicroUsdPerMillion,
      imageMicroUsdPerThousand: row.imageMicroUsdPerThousand,
      audioMicroUsdPerHour: row.audioMicroUsdPerHour,
    } : null;
    const price = resolveModelPrice({ ...entry, override });
    return [{
      ...entry,
      providerLabel: entry.kind === "meta" ? "Meta Model API" : entry.baseUrl ?? "OpenAI-compatible",
      price,
      source: override ? "override" as const
        : !price ? "unpriced" as const
          : entry.kind === "openai-compatible" && isLocalBaseUrl(entry.baseUrl) ? "local" as const : "default" as const,
    }];
  });
}

export async function loadRunCostReceipt(database: Database, ownerId: string, runId: string) {
  const run = await database.select({ id: runs.id }).from(runs)
    .where(and(eq(runs.ownerId, ownerId), eq(runs.id, runId))).limit(1);
  if (!run[0]) return null;
  const rows = await database.select().from(costEntries)
    .where(and(eq(costEntries.ownerId, ownerId), eq(costEntries.runId, runId))).orderBy(asc(costEntries.callIndex));
  return {
    format: "eclipse-crew-cost/1" as const,
    runId,
    currency: "USD" as const,
    totals: {
      calls: rows.length,
      inputTokens: rows.reduce((sum, row) => sum + row.tokensIn, 0),
      outputTokens: rows.reduce((sum, row) => sum + row.tokensOut, 0),
      cachedInputTokens: rows.reduce((sum, row) => sum + row.tokensCached, 0),
      costMicroUsd: rows.reduce((sum, row) => sum + row.costMicroUsd, 0),
    },
    calls: rows.map((row) => ({
      callIndex: row.callIndex,
      providerId: row.providerId,
      model: row.model,
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      tokensCached: row.tokensCached,
      costMicroUsd: row.costMicroUsd,
      outcome: row.outcome,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}
