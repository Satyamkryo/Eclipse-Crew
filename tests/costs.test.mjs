import assert from "node:assert/strict";
import test from "node:test";

import {
  budgetPeriods,
  calculateCostMicroUsd,
  evaluateBudget,
  resolveModelPrice,
} from "../lib/costs/pricing.ts";
import { priceInputSchema } from "../lib/costs/schema.ts";
import { chatCardSchema } from "../lib/chat/schema.ts";

const usage = (inputTokens, outputTokens, cachedInputTokens = 0) => ({
  inputTokens, outputTokens, cachedInputTokens, reasoningTokens: 0,
});

test("built-in Meta prices calculate exact per-million token and per-image costs", () => {
  const spark = resolveModelPrice({ kind: "meta", baseUrl: null, model: "muse-spark-1.3" });
  assert.equal(calculateCostMicroUsd(spark, usage(1_000_000, 100_000, 50_000)), 1_620_000);

  const contributor = resolveModelPrice({ kind: "meta", baseUrl: null, model: "muse-spark-1.3-contributor" });
  assert.equal(calculateCostMicroUsd(contributor, usage(1, 0, 1)), 1);

  const sam = resolveModelPrice({ kind: "meta", baseUrl: null, model: "sam-3.1" });
  assert.equal(calculateCostMicroUsd(sam, usage(0, 0), { images: 1 }), 2_500);
  assert.equal(calculateCostMicroUsd(sam, usage(0, 0), { images: 3 }), 7_500);
});

test("overrides win, local endpoints are free and unpriced hosted models resolve to null", () => {
  const override = resolveModelPrice({
    kind: "meta", baseUrl: null, model: "muse-spark-1.3",
    override: { inputMicroUsdPerMillion: 2_000_000, cachedMicroUsdPerMillion: 0, outputMicroUsdPerMillion: 8_000_000, imageMicroUsdPerThousand: 0 },
  });
  assert.equal(calculateCostMicroUsd(override, usage(1_000_000, 1_000_000)), 10_000_000);

  for (const baseUrl of ["http://localhost:11434/v1", "http://127.0.0.1:8000/v1", "http://host.docker.internal:11434/v1", "http://192.168.1.5:8000/v1", "http://[::1]:8000/v1"]) {
    const local = resolveModelPrice({ kind: "openai-compatible", baseUrl, model: "my-local-model" });
    assert.equal(calculateCostMicroUsd(local, usage(1_000_000, 1_000_000)), 0, baseUrl);
  }
  assert.equal(resolveModelPrice({ kind: "openai-compatible", baseUrl: "https://api.example.com/v1", model: "unknown" }), null);
});

test("price input converts six-decimal USD rates exactly and rejects unsafe values", () => {
  const parsed = priceInputSchema.parse({
    providerId: "11111111-1111-4111-8111-111111111111", model: "muse-spark-1.3",
    inputPerMillion: "1.25", cachedPerMillion: "0.002", outputPerMillion: "4.25", imagePerThousand: "2.50",
  });
  assert.deepEqual(parsed, {
    providerId: "11111111-1111-4111-8111-111111111111", model: "muse-spark-1.3",
    inputMicroUsdPerMillion: 1_250_000, cachedMicroUsdPerMillion: 2_000,
    outputMicroUsdPerMillion: 4_250_000, imageMicroUsdPerThousand: 2_500_000,
  });
  for (const bad of ["-1", "1.2345678", "1001", "", "1e3", " 1.25 "]) {
    assert.equal(priceInputSchema.safeParse({
      providerId: "11111111-1111-4111-8111-111111111111", model: "m",
      inputPerMillion: bad, cachedPerMillion: "0", outputPerMillion: "0", imagePerThousand: "0",
    }).success, false, bad);
  }
  assert.equal(priceInputSchema.safeParse({
    providerId: "not-a-uuid", model: "m", inputPerMillion: "1", cachedPerMillion: "0", outputPerMillion: "0", imagePerThousand: "0",
  }).success, false);
});

test("budget cards are strict and bounded", () => {
  const warning = { type: "budget_warning", period: "daily", spentMicroUsd: 800_000, limitCents: 100 };
  assert.equal(chatCardSchema.safeParse(warning).success, true);
  for (const bad of [
    { ...warning, spentMicroUsd: -1 }, { ...warning, limitCents: 0 }, { ...warning, period: "weekly" },
    { ...warning, extra: true }, { ...warning, type: "budget_paused", spendMicroUsd: 1 },
  ]) assert.equal(chatCardSchema.safeParse(bad).success, false, JSON.stringify(bad));
});

test("daily and monthly bounds follow the owner timezone", () => {
  const now = new Date("2026-11-02T10:00:00.000Z");
  const kolkata = budgetPeriods(now, "Asia/Kolkata");
  assert.equal(kolkata.dayStart.toISOString(), "2026-11-01T18:30:00.000Z");
  assert.equal(kolkata.monthStart.toISOString(), "2026-10-31T18:30:00.000Z");
  assert.equal(kolkata.dayEnd.toISOString(), "2026-11-02T18:30:00.000Z");
  const utc = budgetPeriods(now, "UTC");
  assert.equal(utc.dayStart.toISOString(), "2026-11-02T00:00:00.000Z");
  assert.equal(utc.monthStart.toISOString(), "2026-11-01T00:00:00.000Z");
});

test("budget evaluation warns at 80 percent and pauses at 100 percent in the most constrained period", () => {
  assert.equal(evaluateBudget({ daySpentMicroUsd: 79, monthSpentMicroUsd: 0, dailyLimitCents: 1, monthlyLimitCents: 10 }).state, "ok");
  const warning = evaluateBudget({ daySpentMicroUsd: 8_000, monthSpentMicroUsd: 10_000, dailyLimitCents: 1, monthlyLimitCents: 10 });
  assert.deepEqual([warning.state, warning.period], ["warning", "daily"]);
  const paused = evaluateBudget({ daySpentMicroUsd: 9_000, monthSpentMicroUsd: 100_000, dailyLimitCents: 1, monthlyLimitCents: 10 });
  assert.deepEqual([paused.state, paused.period], ["paused", "monthly"]);
});
