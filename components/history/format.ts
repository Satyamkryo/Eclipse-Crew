import type { RunTone } from "@/lib/receipts/history-view";

export function formatTime(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(date);
  }
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const total = Math.round(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// Receipts store micro-USD; the cost ledger fills them in later, so null is normal.
export function formatCost(micro: number | null): string {
  return micro === null ? "—" : `$${(micro / 1_000_000).toFixed(4)}`;
}

export const shortHash = (value: string) => (value.length > 12 ? `${value.slice(0, 12)}…` : value);

// Status colour is never the only signal: every badge also carries a label and an icon.
export const TONE_CLASS: Record<RunTone, string> = {
  success: "bg-success/12 text-success",
  danger: "bg-danger/12 text-danger",
  warning: "bg-corona/12 text-corona",
  neutral: "border border-border bg-muted text-muted-foreground",
};
