// TASK-051. The only visual change Astra Mode makes. Visible text, not colour alone.
export function AstraBadge() {
  return (
    <span className="shrink-0 rounded-md bg-destructive px-1.5 py-0.5 text-xs font-semibold uppercase text-destructive-foreground">
      Astra Mode
    </span>
  );
}
