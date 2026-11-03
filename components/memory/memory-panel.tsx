"use client";

import { useEffect, useState } from "react";
import { LoaderCircle, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DocumentView } from "./document-view";
import { ChangeRequests } from "./change-requests";
import { EntryForm } from "./entry-form";
import { HistoryView } from "./history-view";

export type MemoryEntry = {
  id: string; doc: "user" | "memory" | "private"; agentId: string | null; scope: "global" | "agent" | "private";
  visibleTo: string[]; title: string; body: string; pinned: boolean; trusted: boolean; status: "active" | "archived";
  author: "owner" | "agent"; sourceRunId: string | null; sourceLabel: string | null; version: number;
  createdAt: string; updatedAt: string;
};
export type MemoryDocumentView = { entries: MemoryEntry[]; chars: number; cap: number };
export type MemoryViewData = {
  soul: { text: string; updatedAt: string | null };
  user: MemoryDocumentView; memory: MemoryDocumentView; private: MemoryDocumentView;
  mode: "auto" | "ask";
  agents: { id: string; name: string }[];
  mirror: { ok: boolean; reason: "not_writable" | "missing" | null };
};
type Doc = "user" | "memory" | "private" | "soul";

const DOC_TABS: { id: Doc; label: string }[] = [
  { id: "user", label: "USER.md" },
  { id: "memory", label: "MEMORY.md" },
  { id: "private", label: "Private notes" },
  { id: "soul", label: "SOUL.md" },
];

function docKey(agentId: string, doc: Doc): string {
  return doc === "user" ? "user" : `agent:${agentId}:${doc}`;
}

export function MemoryPanel({ agentId, csrfToken, timeZone }: { agentId?: string; csrfToken: string; timeZone: string }) {
  const [view, setView] = useState<"documents" | "changes" | "history">("documents");
  const [pending, setPending] = useState(0);
  const [doc, setDoc] = useState<Doc>("memory");
  const [data, setData] = useState<MemoryViewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<MemoryEntry | null>(null);
  const [version, setVersion] = useState(0);
  const [modeBusy, setModeBusy] = useState(false);

  useEffect(() => {
    if (!agentId) return;
    const controller = new AbortController();
    fetch(`/api/memory/${agentId}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return await response.json() as MemoryViewData;
      })
      .then((body) => { if (!controller.signal.aborted) { setData(body); setError(false); } })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [agentId, version]);

  if (!agentId) {
    return (
      <div className="flex h-full min-h-48 flex-col items-center justify-center gap-1 px-6 py-12 text-center">
        <p className="text-sm font-medium">Memory</p>
        <p className="text-sm text-muted-foreground">Select an agent to see its memory.</p>
      </div>
    );
  }
  if (loading && !data) return <p role="status" className="p-6 text-sm text-muted-foreground">Loading memory…</p>;
  if (error && !data) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 p-6">
        <p className="text-sm text-danger">Memory could not be loaded.</p>
        <button type="button" onClick={() => setVersion((value) => value + 1)} className="text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">Try again</button>
      </div>
    );
  }
  const current = data as MemoryViewData;

  const setMode = async (mode: "auto" | "ask", all: boolean) => {
    if (modeBusy) return;
    setModeBusy(true);
    try {
      const response = all
        ? await fetch("/api/memory/upgrade", { method: "POST", headers: { "x-csrf-token": csrfToken } })
        : await fetch(`/api/memory/${agentId}`, { method: "PATCH", headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify({ mode }) });
      if (response.ok) setVersion((value) => value + 1);
    } finally { setModeBusy(false); }
  };

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-corona/12 px-4 py-2">
        <p className="text-xs text-muted-foreground">
          {current.mode === "auto"
            ? "Automatic memory is on: a fact you stated can be saved at once, with Undo in chat."
            : "Memory only saves what you approve. Turn it on to let agents remember what you tell them."}
        </p>
        <div className="flex flex-wrap gap-2">
          {current.mode === "ask" ? (
            <>
              <Button type="button" size="sm" disabled={modeBusy} onClick={() => setMode("auto", false)}>Turn on for this agent</Button>
              <Button type="button" size="sm" variant="secondary" disabled={modeBusy} onClick={() => setMode("auto", true)}>Upgrade memory for all agents</Button>
            </>
          ) : (
            <Button type="button" size="sm" variant="secondary" disabled={modeBusy} onClick={() => setMode("ask", false)}>Turn off automatic memory</Button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div role="tablist" aria-label="Memory views" className="flex rounded-md border border-border p-0.5">
          {(["documents", "changes", "history"] as const).map((id) => (
            <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)}
              className={cn("rounded-sm px-3 py-1 text-sm transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-ring",
                view === id ? "bg-surface-hover text-foreground" : "text-muted-foreground hover:text-foreground")}>
              {id === "documents" ? "Documents" : id === "changes" ? `Change requests${pending ? ` (${pending})` : ""}` : "History"}
            </button>
          ))}
        </div>
        {view === "documents" && doc !== "soul" ? (
          <Button type="button" size="sm" onClick={() => { setAdding(true); setEditing(null); }}>
            <Plus aria-hidden="true" className="size-4" />Add memory
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-1 border-b border-border px-3 py-2">
        {DOC_TABS.map((tab) => (
          <button key={tab.id} type="button" aria-pressed={doc === tab.id}
            onClick={() => { setDoc(tab.id); setAdding(false); setEditing(null); }}
            className={cn("rounded-md px-2 py-1 text-xs transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-ring",
              doc === tab.id ? "bg-surface-hover text-foreground" : "text-muted-foreground hover:text-foreground")}>
            {tab.label}
          </button>
        ))}
      </div>

      {!current.mirror.ok ? (
        <p role="status" className="border-b border-border bg-corona/12 px-4 py-2 text-xs text-corona">
          Mirror to ./data/memory failed ({current.mirror.reason === "missing" ? "folder missing" : "not writable"}). Memory is still saved.
        </p>
      ) : null}

      {view === "history" ? (
        <HistoryView agentId={agentId} docKey={docKey(agentId, doc)} title={DOC_TABS.find((tab) => tab.id === doc)?.label ?? "Document"} timeZone={timeZone} csrfToken={csrfToken} onChanged={() => setVersion((value) => value + 1)} />
      ) : view === "changes" ? (
        <ChangeRequests agentId={agentId} csrfToken={csrfToken} onCount={setPending} />
      ) : (
        <>
          {adding || editing ? (
            <EntryForm agentId={agentId} csrfToken={csrfToken} doc={doc === "soul" ? "memory" : doc}
              agents={current.agents} entry={editing ?? undefined}
              onCancel={() => { setAdding(false); setEditing(null); }}
              onSaved={() => { setAdding(false); setEditing(null); setVersion((value) => value + 1); }} />
          ) : null}
          <DocumentView agentId={agentId} doc={doc} data={current} csrfToken={csrfToken}
            onEdit={(entry) => { setEditing(entry); setAdding(false); }}
            onChanged={() => setVersion((value) => value + 1)} />
        </>
      )}
    </div>
  );
}

export function SavingSpinner({ saving }: { saving: boolean }) {
  return saving ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> : null;
}
