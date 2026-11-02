"use client";

import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { diffSnapshots } from "@/lib/memory/diff";
import { cn } from "@/lib/utils";
import { DiffView } from "./diff-view";
import { UndoNotice } from "./undo-notice";

type Version = {
  id: string; docKey: string; seq: number; entryId: string | null; agentId: string | null; op: string;
  before: { title?: string; body?: string; pinned?: boolean; status?: string; scope?: string } | null;
  after: { title?: string; body?: string; pinned?: boolean; status?: string; scope?: string } | null;
  author: "owner" | "agent"; authorAgentId: string | null; reason: string | null; sourceRunId: string | null; createdAt: string;
};

const OP_LABEL: Record<string, string> = {
  add: "Added", edit: "Edited", remove: "Removed", pin: "Pinned", unpin: "Unpinned", soul_edit: "SOUL.md edited", undo: "Undone",
};

export function HistoryView({ agentId, docKey, title, timeZone, csrfToken, onChanged }: {
  agentId: string; docKey: string; title: string; timeZone: string; csrfToken: string; onChanged?: () => void;
}) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/memory/${agentId}/history?doc=${encodeURIComponent(docKey)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return await response.json() as { versions: Version[] };
      })
      .then((body) => { if (!controller.signal.aborted) { setVersions(body.versions); setError(false); } })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [agentId, docKey, version]);

  if (versions === null && !error) return <p role="status" className="p-6 text-sm text-muted-foreground">Loading history…</p>;
  if (error) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 p-6">
        <p className="text-sm text-danger">History could not be loaded.</p>
        <button type="button" onClick={() => setVersion((value) => value + 1)} className="text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">Try again</button>
      </div>
    );
  }
  if (!versions?.length) return <p className="p-6 text-sm text-muted-foreground">No changes to {title} yet.</p>;
  const current = versions.find((item) => item.id === selected) ?? versions[0];

  return (
    <div className="flex flex-col">
      <ul aria-label={`${title} version history`} className="divide-y divide-border">
        {versions.map((item) => (
          <li key={item.id}>
            <button type="button" onClick={() => setSelected(item.id)} aria-pressed={current.id === item.id}
              className={cn("flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-[-2px] focus-visible:outline-ring",
                current.id === item.id && "bg-surface-hover")}>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">v{item.seq} {OP_LABEL[item.op] ?? item.op}{item.after?.title ? ` · ${item.after.title}` : ""}</span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {item.author === "owner" ? "Owner" : "Agent"}{item.reason ? ` · ${item.reason}` : ""} · <time dateTime={item.createdAt}>{formatTime(item.createdAt, timeZone)}</time>
                </span>
              </span>
              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>
      <section aria-label="Version diff" className="border-t border-border p-4">
        <h3 className="text-sm font-semibold">v{current.seq}: {OP_LABEL[current.op] ?? current.op}</h3>
        {current.op === "undo" ? <p className="mt-1 text-xs text-muted-foreground">This version restores an earlier state.</p> : null}
        <div className="mt-3">
          <DiffView lines={diffSnapshots(current.before, current.after)} />
        </div>
        {current.op !== "undo" && versions[0]?.id === current.id ? (
          <UndoNotice versionId={current.id} csrfToken={csrfToken} onUndone={() => { setVersion((value) => value + 1); onChanged?.(); }} />
        ) : null}
      </section>
    </div>
  );
}

function formatTime(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
  } catch {
    return date.toISOString();
  }
}
