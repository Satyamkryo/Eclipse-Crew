"use client";

import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

// Dark-safe native select: hides the mismatched OS arrow and uses a Lucide chevron.
export function Select({ label, id, name, value, defaultValue, onChange, required, disabled, className, selectClassName, children }: {
  label: string; id?: string; name?: string; value?: string; defaultValue?: string;
  onChange?: (value: string) => void; required?: boolean; disabled?: boolean;
  className?: string; selectClassName?: string; children: React.ReactNode;
}) {
  return (
    <span className={cn("relative inline-flex max-w-full items-center", className)}>
      <select aria-label={label} id={id} name={name} value={value} defaultValue={defaultValue}
        required={required} disabled={disabled}
        onChange={onChange ? (event) => onChange(event.target.value) : undefined}
        className={cn("h-8 max-w-full appearance-none rounded-md border border-input bg-card pl-2 pr-8 text-sm focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60", selectClassName)}>
        {children}
      </select>
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-2 size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
    </span>
  );
}
