"use client";

import { useState } from "react";
import { LoaderCircle, Pin, PinOff, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/workspace/modal-dialog";
import { cn } from "@/lib/utils";
import type { MemoryDocumentView, MemoryEntry, MemoryViewData } from "./memory-panel";

const DOC_COPY = {
  user: { title: "USER.md", body: "Shared by the whole crew. Entries are readable by an agent whose memory scopes include global." },
  memory: { title: "MEMORY.md", body: "Facts this agent should always know. Only this agent can read them." },
  private: { title: "Private notes", body: "Visible to this agent, and to any agent you add to its list. The owner always sees them." },
  soul: { title: "SOUL.md", body: "This agent's persona. It is the same text as the persona in Agent settings." },
} as const;

export function DocumentView({ agentId, doc, data, csrfToken, onEdit, onChanged }: {
  agentId: string; doc: "user" | "memory" | "private" | "soul"; data: MemoryViewData;
  csrfToken: string; onEdit: (entry: MemoryEntry) => void; onChanged: () => void;
}) {
  const [soul, setSoul] = useState(data.soul.text);
  const [savingSoul, setSavingSoul] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<MemoryEntry | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function saveSoul() {
    if (savingSoul) return;
    setSavingSoul(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/memory/${agentId}/soul`, {
        method: "PUT", headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ soulMd: soul }),
      });
      if (!response.ok) { setMessage({ tone: "error", text: "Couldn't save SOUL.md. Check the length and try again." }); return; }
      setMessage({ tone: "ok", text: "SOUL.md saved." });
      onChanged();
    } catch {
      setMessage({ tone: "error", text: "Unable to connect. Try again." });
    } finally {
      setSavingSoul(false);
    }
  }

  async function togglePin(entry: MemoryEntry) {
    if (busyId) return;
    setBusyId(entry.id);
    setMessage(null);
    try {
      const response = await fetch(`/api/memory/entries/${entry.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ pinned: !entry.pinned }),
      });
      if (!response.ok) { setMessage({ tone: "error", text: "Couldn't change the pin. Try again." }); return; }
      onChanged();
    } catch {
      setMessage({ tone: "error", text: "Unable to connect. Try again." });
    } finally {
      setBusyId(null);
    }
  }

  async function remove(entry: MemoryEntry) {
    setRemoveTarget(null);
    setBusyId(entry.id);
    setMessage(null);
    try {
      const response = await fetch(`/api/memory/entries/${entry.id}`, {
        method: "DELETE", headers: { "x-csrf-token": csrfToken },
      });
      if (!response.ok) { setMessage({ tone: "error", text: "Couldn't remove this entry. Try again." }); return; }
      setMessage({ tone: "ok", text: "Entry removed. You can restore it from History." });
      onChanged();
    } catch {
      setMessage({ tone: "error", text: "Unable to connect. Try again." });
    } finally {
      setBusyId(null);
    }
  }

  const copy = DOC_COPY[doc];
  if (doc === "soul") {
    return (
      <section className="flex flex-col gap-3 p-4">
        <div>
          <h3 className="text-sm font-semibold">{copy.title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{copy.body}</p>
        </div>
        <label htmlFor="soul-text" className="text-sm font-medium">Persona</label>
        <textarea id="soul-text" value={soul} maxLength={2_000} rows={12} onChange={(event) => setSoul(event.target.value)}
          className="w-full rounded-md border border-input bg-surface px-3 py-2 text-base leading-6 focus:outline-none focus:ring-2 focus:ring-ring" />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs tabular-nums text-muted-foreground">{soul.length} / 2,000 characters</span>
          <Button type="button" disabled={savingSoul || soul.trim().length === 0} onClick={() => void saveSoul()}>
            {savingSoul ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> : null}Save SOUL.md
          </Button>
        </div>
        {message ? <p role={message.tone === "error" ? "alert" : "status"} className={cn("text-sm", message.tone === "error" ? "text-danger" : "text-muted-foreground")}>{message.text}</p> : null}
      </section>
    );
  }

  const document: MemoryDocumentView = data[doc];
  return (
    <section className="flex flex-col gap-3 p-4">
      <div>
        <h3 className="text-sm font-semibold">{copy.title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{copy.body}</p>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <div role="meter" aria-label={`${copy.title} characters used`} aria-valuemin={0} aria-valuemax={document.cap} aria-valuenow={document.chars}
          className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-border">
          <div className="h-full bg-primary" style={{ width: `${Math.min(100, Math.round((document.chars / document.cap) * 100))}%` }} />
        </div>
        <span className="shrink-0 tabular-nums">{document.chars.toLocaleString()} / {document.cap.toLocaleString()}</span>
      </div>
      {message ? <p role={message.tone === "error" ? "alert" : "status"} className={cn("text-sm", message.tone === "error" ? "text-danger" : "text-muted-foreground")}>{message.text}</p> : null}
      {document.entries.length === 0 ? (
        <div className="flex min-h-40 flex-col items-center justify-center gap-1 rounded-lg border border-border px-6 py-10 text-center">
          <p className="text-sm font-medium">No memory yet.</p>
          <p className="text-sm text-muted-foreground">Add what this agent should always know.</p>
        </div>
      ) : (
        <ul aria-label={`${copy.title} entries`} className="divide-y divide-border rounded-lg border border-border">
          {document.entries.map((entry) => (
            <li key={entry.id} className="flex flex-col gap-2 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <p className="min-w-0 break-words text-sm font-medium">{entry.title}</p>
                  <span className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground">{entry.scope}</span>
                  {entry.pinned ? <span className="rounded-md border border-border-strong px-1.5 py-0.5 text-xs">Pinned</span> : null}
                  {!entry.trusted ? <span className="rounded-md bg-corona/12 px-1.5 py-0.5 text-xs text-corona">{entry.sourceLabel?.trim() || "Untrusted source"}</span> : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button type="button" variant="ghost" size="sm" aria-label={entry.pinned ? `Unpin ${entry.title}` : `Pin ${entry.title}`}
                    disabled={busyId !== null} onClick={() => void togglePin(entry)}>
                    {entry.pinned ? <PinOff aria-hidden="true" className="size-4" /> : <Pin aria-hidden="true" className="size-4" />}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" aria-label={`Edit ${entry.title}`} onClick={() => onEdit(entry)}>
                    <Pencil aria-hidden="true" className="size-4" />
                  </Button>
                  <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${entry.title}`} onClick={() => setRemoveTarget(entry)}>
                    <Trash2 aria-hidden="true" className="size-4" />
                  </Button>
                </div>
              </div>
              <p className="whitespace-pre-wrap break-words text-base leading-6">{entry.body}</p>
              <p className="text-xs text-muted-foreground">
                {entry.author === "owner" ? "Owner" : "Agent"} · v{entry.version} · <time dateTime={entry.updatedAt}>{new Date(entry.updatedAt).toLocaleString()}</time>
              </p>
            </li>
          ))}
        </ul>
      )}
      {removeTarget ? (
        <ModalDialog title={`Remove “${removeTarget.title}”?`} description="This entry leaves the agent's instructions. You can restore it from History." onClose={() => setRemoveTarget(null)}>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setRemoveTarget(null)}>Cancel</Button>
            <Button type="button" variant="destructive" onClick={() => void remove(removeTarget)}>Remove memory</Button>
          </div>
        </ModalDialog>
      ) : null}
    </section>
  );
}
