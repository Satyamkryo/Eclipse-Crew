import { cn } from "@/lib/utils";
import type { DiffLine } from "@/lib/memory/diff";

export function DiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <ol aria-label="Changes" className="overflow-x-auto rounded-md border border-border font-mono text-xs">
      {lines.map((line, index) => (
        <li key={`${index}-${line.type}`} className={cn("flex gap-2 px-2 py-0.5",
          line.type === "add" ? "bg-success/12 text-success" : line.type === "remove" ? "bg-danger/12 text-danger" : "text-muted-foreground")}>
          <span aria-hidden="true" className="w-3 shrink-0 select-none">{line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}</span>
          <span className="min-w-0 whitespace-pre-wrap break-words">{line.text}</span>
          <span className="sr-only">{line.type === "add" ? " added line" : line.type === "remove" ? " removed line" : " unchanged line"}</span>
        </li>
      ))}
    </ol>
  );
}
