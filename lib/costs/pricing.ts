export type PriceProviderKind = "meta" | "openai-compatible";

export interface ModelPriceRates {
  inputMicroUsdPerMillion: number;
  cachedMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
  imageMicroUsdPerThousand: number;
  audioMicroUsdPerHour?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

const ZERO: ModelPriceRates = {
  inputMicroUsdPerMillion: 0,
  cachedMicroUsdPerMillion: 0,
  outputMicroUsdPerMillion: 0,
  imageMicroUsdPerThousand: 0,
};

// PRD section 9, verified against Meta's model page on 2026-10-28.
export const META_PRICES: Readonly<Record<string, ModelPriceRates>> = Object.freeze({
  "muse-spark-1.3": { inputMicroUsdPerMillion: 1_250_000, cachedMicroUsdPerMillion: 150_000, outputMicroUsdPerMillion: 4_250_000, imageMicroUsdPerThousand: 0 },
  "muse-spark-1.3-contributor": { inputMicroUsdPerMillion: 100_000, cachedMicroUsdPerMillion: 2_000, outputMicroUsdPerMillion: 200_000, imageMicroUsdPerThousand: 0 },
  "muse-wonder-1.0": { inputMicroUsdPerMillion: 4_000_000, cachedMicroUsdPerMillion: 200_000, outputMicroUsdPerMillion: 20_000_000, imageMicroUsdPerThousand: 0 },
  // https://dev.meta.ai/docs/pricing-rate-limits verified 2026-11-02.
  "muse-voice-transcribe-1.0": { ...ZERO, audioMicroUsdPerHour: 180_000 },
  "sam-3.1": { inputMicroUsdPerMillion: 0, cachedMicroUsdPerMillion: 0, outputMicroUsdPerMillion: 0, imageMicroUsdPerThousand: 2_500_000 },
});

export function isLocalBaseUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "host.docker.internal" || host === "::1" || host.endsWith(".local")) return true;
    if (/^127\./.test(host)) return true;
    const octets = host.split(".").map(Number);
    if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
      return octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 192 && octets[1] === 168) || (octets[0] === 169 && octets[1] === 254);
    }
    return false;
  } catch {
    return false;
  }
}

// null means a hosted model has no usable price. The run must stop before spending rather than bypass the budget.
export function resolveModelPrice(input: {
  kind: PriceProviderKind;
  baseUrl: string | null;
  model: string;
  override?: ModelPriceRates | null;
}): ModelPriceRates | null {
  if (input.override) return input.override;
  if (input.kind === "openai-compatible" && isLocalBaseUrl(input.baseUrl)) return ZERO;
  return META_PRICES[input.model] ?? null;
}

const nonNegative = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid_${name}`);
  return BigInt(value);
};

const MILLION = BigInt(1_000_000);
const THOUSAND = BigInt(1_000);
const ONE = BigInt(1);
const ZERO_BIG = BigInt(0);

const ceilDivide = (value: bigint, divisor: bigint) => (value + divisor - ONE) / divisor;

export function calculateCostMicroUsd(
  price: ModelPriceRates,
  usage: TokenUsage,
  { images = 0, audioDurationMs = 0 }: { images?: number; audioDurationMs?: number } = {},
): number {
  const input = nonNegative(usage.inputTokens, "input_tokens");
  const cached = nonNegative(usage.cachedInputTokens, "cached_tokens");
  const output = nonNegative(usage.outputTokens, "output_tokens");
  const imageCount = nonNegative(images, "images");
  if (cached > input) throw new Error("invalid_cached_tokens");
  for (const [name, value] of Object.entries(price)) nonNegative(value, name);

  const uncachedInput = input - cached;
  const tokenCost = ceilDivide(
    uncachedInput * BigInt(price.inputMicroUsdPerMillion) +
      cached * BigInt(price.cachedMicroUsdPerMillion) +
      output * BigInt(price.outputMicroUsdPerMillion),
    MILLION,
  );
  const imageCost = ceilDivide(imageCount * BigInt(price.imageMicroUsdPerThousand), THOUSAND);
  const seconds = nonNegative(audioDurationMs, "audio_duration") / BigInt(1000);
  const audioCost = ceilDivide(seconds * BigInt(price.audioMicroUsdPerHour ?? 0), BigInt(3600));
  const total = tokenCost + imageCost + audioCost;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("cost_overflow");
  return Number(total);
}

export type BudgetPeriod = "daily" | "monthly";
export type BudgetState = "ok" | "warning" | "paused";

export interface BudgetPeriods {
  dayStart: Date;
  dayEnd: Date;
  monthStart: Date;
  monthEnd: Date;
}

function localDateParts(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", timeZoneName: "longOffset",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const offsetName = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(offsetName);
  const offset = match ? (match[1] === "-" ? -1 : 1) * (Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)) * 60_000 : null;
  if (offset === null) throw new Error("invalid_timezone");
  return { year: get("year"), month: get("month"), day: get("day"), offset: offset ?? 0 };
}

function zonedMidnight(year: number, month: number, day: number, timezone: string): Date {
  // Sampling the offset at UTC midnight gives the civil-offset in effect around local midnight for every zone in our
  // supported set, including DST-change days whose clocks change after 00:00.
  const guess = new Date(Date.UTC(year, month - 1, day));
  return new Date(guess.getTime() - localDateParts(guess, timezone).offset);
}

export function budgetPeriods(now: Date, timezone: string): BudgetPeriods {
  const local = localDateParts(now, timezone);
  const dayStart = zonedMidnight(local.year, local.month, local.day, timezone);
  const nextDay = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  const monthStart = zonedMidnight(local.year, local.month, 1, timezone);
  const nextMonth = new Date(Date.UTC(local.year, local.month, 1));
  return {
    dayStart,
    dayEnd: zonedMidnight(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), timezone),
    monthStart,
    monthEnd: zonedMidnight(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth() + 1, nextMonth.getUTCDate(), timezone),
  };
}

export function evaluateBudget(input: {
  daySpentMicroUsd: number;
  monthSpentMicroUsd: number;
  dailyLimitCents: number;
  monthlyLimitCents: number;
}): { state: BudgetState; period: BudgetPeriod; dayLimitMicroUsd: number; monthLimitMicroUsd: number } {
  const values = [input.daySpentMicroUsd, input.monthSpentMicroUsd, input.dailyLimitCents, input.monthlyLimitCents];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error("invalid_budget");
  const dayLimit = BigInt(input.dailyLimitCents) * BigInt(10_000);
  const monthLimit = BigInt(input.monthlyLimitCents) * BigInt(10_000);
  const daySpent = BigInt(input.daySpentMicroUsd);
  const monthSpent = BigInt(input.monthSpentMicroUsd);
  const capped = dayLimit > ZERO_BIG && daySpent >= dayLimit;
  const monthlyCapped = monthLimit > ZERO_BIG && monthSpent >= monthLimit;
  const dayWarned = dayLimit > ZERO_BIG && daySpent * BigInt(5) >= dayLimit * BigInt(4);
  const monthWarned = monthLimit > ZERO_BIG && monthSpent * BigInt(5) >= monthLimit * BigInt(4);

  let period: BudgetPeriod = "daily";
  if (monthlyCapped || (!capped && monthWarned && !dayWarned)) period = "monthly";
  else if (capped && daySpent * monthLimit >= monthSpent * dayLimit) period = "daily";

  return {
    state: capped || monthlyCapped ? "paused" : dayWarned || monthWarned ? "warning" : "ok",
    period,
    dayLimitMicroUsd: Number(dayLimit),
    monthLimitMicroUsd: Number(monthLimit),
  };
}
