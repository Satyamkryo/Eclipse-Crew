import { z } from "zod";

const MAX_RATE_MICRO_USD = 1_000_000_000;

const usdRate = z.string()
  .max(20)
  .regex(/^(?:0|[1-9]\d{0,3})(?:\.\d{1,6})?$/)
  .transform((value) => {
    const [whole, fraction = ""] = value.split(".");
    return Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"));
  })
  .refine((value) => value <= MAX_RATE_MICRO_USD);

export const priceInputSchema = z.object({
  providerId: z.string().uuid(),
  model: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
  inputPerMillion: usdRate,
  cachedPerMillion: usdRate,
  outputPerMillion: usdRate,
  imagePerThousand: usdRate,
  audioPerHour: usdRate.optional(),
}).strict().transform((value) => ({
  providerId: value.providerId,
  model: value.model,
  inputMicroUsdPerMillion: value.inputPerMillion,
  cachedMicroUsdPerMillion: value.cachedPerMillion,
  outputMicroUsdPerMillion: value.outputPerMillion,
  imageMicroUsdPerThousand: value.imagePerThousand,
  ...(value.audioPerHour === undefined ? {} : { audioMicroUsdPerHour: value.audioPerHour }),
}));

export type PriceInput = z.output<typeof priceInputSchema>;
