import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

// Reference page headers (images 02, 06–18): circular icon tile, page title, one-line
// subtitle, and a single primary action on the right.
export function PageHeader({ icon: Icon, title, subtitle, action, children }: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4 pb-4">
      <div className="flex min-w-0 items-start gap-4">
        <span aria-hidden="true" className="flex size-11 shrink-0 items-center justify-center rounded-full border border-border bg-surface">
          <Icon className="size-5" strokeWidth={1.5} />
        </span>
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      {children}
    </header>
  );
}
