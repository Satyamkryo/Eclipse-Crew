"use client";

import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

// TASK-054. Undo appends a new version; it never edits history. Only the latest version of an entry can be undone.
export function UndoNotice({ versionId, csrfToken, onUndone }: { versionId: string; csrfToken: string; onUndone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function undo() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/memory/versions/${versionId}/undo`, {
        method: "POST", headers: { "x-csrf-token": csrfToken },
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        setMessage({ tone: "error", text: body.error === "pinned" ? "This entry is pinned. Unpin it before restoring an older body."
          : body.error === "not_latest" ? "Only the latest change to this entry can be undone."
            : body.error === "over_cap" ? "Restoring this version would exceed the document's character cap."
            : body.error === "duplicate_title" ? "Another entry already uses that title. Rename it before restoring this version."
              : "Couldn't undo this change. Try again." });
        return;
      }
      setMessage({ tone: "ok", text: "Change undone. A new version records the restore." });
      onUndone?.();
    } catch {
      setMessage({ tone: "error", text: "Unable to connect. Try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => void undo()}>
        {busy ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> : null}Undo this change
      </Button>
      {message ? <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "text-sm text-danger" : "text-sm text-muted-foreground"}>{message.text}</p> : null}
    </div>
  );
}
