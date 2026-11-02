"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { ChangeActions } from "./change-actions";

type Change = {
  id: string; agentId: string; runId: string | null; doc: "user" | "memory" | "private"; scope: "global" | "agent" | "private";
  title: string; body: string; reason: string; flags: string[]; state: string; createdAt: string; expired: boolean;
};

const DOC_LABEL = { user: "USER.md", memory: "MEMORY.md", private: "Private notes" } as const;

export function ChangeRequests({ agentId, csrfToken, onCount }: { agentId: string; csrfToken: string; onCount?: (count: number) => void }) {
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/memory/changes?agent=${agentId}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return await response.json() as { changes: Change[] };
      })
      .then((body) => {
        if (controller.signal.aborted) return;
        setChanges(body.changes);
        onCount?.(body.changes.filter((change) => !change.expired).length);
      })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [agentId, version, onCount]);

  if (error) return <p role="alert" className="p-6 text-sm text-danger">Change requests could not be loaded.</p>;
  if (changes === null) return <p role="status" className="p-6 text-sm text-muted-foreground">Loading change requests…</p>;
  if (changes.length === 0) {
    return (
      <div className="flex min-h-40 flex-col items-center justify-center gap-1 px-6 py-12 text-center">
        <p className="text-sm font-medium">No change requests.</p>
        <p className="text-sm text-muted-foreground">When this agent asks to remember something, it appears here for your review.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      <ul aria-label="Memory change requests" className="divide-y divide-border">
        {changes.map((change) => (
          <li key={change.id}>
            <button type="button" onClick={() => setSelected(change.id)} aria-pressed={selected === change.id}
              className={cn("w-full px-4 py-3 text-left transition-colors duration-150 hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-[-2px] focus-visible:outline-ring",
                selected === change.id && "bg-surface-hover")}>
              <span className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{change.title}</span>
                <span className="rounded-md border border-border px-1.5 py-0.5 text-xs">{DOC_LABEL[change.doc]}</span>
                <span className="rounded-md border border-border px-1.5 py-0.5 text-xs">{change.scope}</span>
                {change.expired ? <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">Expired</span> : null}
              </span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                {change.reason} · <time dateTime={change.createdAt}>{new Date(change.createdAt).toLocaleString()}</time>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {selected ? (
        <section aria-label="Change review" className="border-t border-border p-4">
          <ChangeActions key={`${selected}-${version}`} changeId={selected} csrfToken={csrfToken} />
          <button type="button" onClick={() => setVersion((value) => value + 1)} className="mt-3 text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">
            Refresh requests
          </button>
        </section>
      ) : null}
    </div>
  );
}
