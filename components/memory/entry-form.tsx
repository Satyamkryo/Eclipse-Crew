"use client";

import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MemoryEntry } from "./memory-panel";

const DOC_LABEL = { user: "USER.md", memory: "MEMORY.md", private: "Private notes" } as const;

export function EntryForm({ agentId, csrfToken, doc, entry, onCancel, onSaved }: {
  agentId: string; csrfToken: string; doc: "user" | "memory" | "private"; entry?: MemoryEntry;
  onCancel: () => void; onSaved: () => void;
}) {
  const [title, setTitle] = useState(entry?.title ?? "");
  const [body, setBody] = useState(entry?.body ?? "");
  const [pinned, setPinned] = useState(entry?.pinned ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(entry ? `/api/memory/entries/${entry.id}` : `/api/memory/${agentId}/entries`, {
        method: entry ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ ...(entry ? {} : { doc }), title, body, pinned }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string };
        setError(data.error === "over_cap" ? "This entry does not fit under the document's character cap. Remove or shorten another entry first."
          : data.error === "duplicate_title" ? "An entry with this title already exists in this document."
            : "Couldn't save this entry. Try again.");
        return;
      }
      onSaved();
    } catch {
      setError("Unable to connect. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="border-b border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">{entry ? "Edit memory" : `Add to ${DOC_LABEL[doc]}`}</h3>
      <div className="mt-3 flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Title</span>
          <input value={title} maxLength={80} required onChange={(event) => setTitle(event.target.value)}
            className="h-8 rounded-md border border-input bg-card px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Memory</span>
          <textarea value={body} maxLength={600} rows={4} required onChange={(event) => setBody(event.target.value)}
            className="rounded-md border border-input bg-card px-3 py-2 text-base leading-6 focus:outline-none focus:ring-2 focus:ring-ring" />
          <span className="self-end text-xs tabular-nums text-muted-foreground">{body.length} / 600</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={pinned} onChange={(event) => setPinned(event.target.checked)} className="size-4 rounded border-input" />
          Pin this entry
        </label>
        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" disabled={saving} onClick={onCancel}>Cancel</Button>
          <Button type="submit" disabled={saving || title.trim().length === 0 || body.trim().length === 0}>
            {saving ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> : null}
            {entry ? "Save changes" : "Add memory"}
          </Button>
        </div>
      </div>
    </form>
  );
}
