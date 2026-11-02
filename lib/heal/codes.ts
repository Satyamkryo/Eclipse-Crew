// TASK-044. The mismatch codes self-healing may repair: each means the site changed under a saved replay. Shared by the
// proposal schema, the repair task and the UI, so it lives in its own module with no server imports.
export const HEAL_FAILURE_CODES = [
  "target_missing",
  "ambiguous_target",
  "target_changed",
  "unsupported_focus",
  "postcondition_failed",
  "postcondition_unknown",
] as const;

export type HealFailureCode = (typeof HEAL_FAILURE_CODES)[number];

export const isHealFailureCode = (value: string): value is HealFailureCode =>
  (HEAL_FAILURE_CODES as readonly string[]).includes(value);
