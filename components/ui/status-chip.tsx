import { cn } from "@/lib/utils";

// Reference sheet 35 "Status labels · always textual": a small chip with a dot and a label.
// Colour is never the only signal — the label is always present.
const TONES = {
  success: "border-success/40 bg-success/12 text-success",
  neutral: "border-border bg-surface text-muted-foreground",
  danger: "border-danger/40 bg-danger/12 text-danger",
  corona: "border-corona/40 bg-corona/12 text-corona",
  live: "border-border bg-surface text-foreground",
} as const;

const DOTS = {
  success: "bg-success",
  neutral: "bg-muted-foreground",
  danger: "bg-danger",
  corona: "bg-corona",
  live: "bg-foreground motion-safe:animate-pulse",
} as const;

export type StatusChipProps = {
  tone: keyof typeof TONES;
  label: string;
  className?: string;
};

export function StatusChip({ tone, label, className }: StatusChipProps) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium", TONES[tone], className)}>
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", DOTS[tone])} />
      {label}
    </span>
  );
}
