"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

// TASK-086. Undo one auto-saved change or one whole tidy batch.
export function MemoryUndo({ kind, id, csrfToken }: { kind: "version" | "batch"; id: string; csrfToken: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  async function undo() {
    if (state === "busy" || state === "done") return;
    setState("busy");
    try {
      const path = kind === "version" ? `/api/memory/versions/${id}/undo` : `/api/memory/batches/${id}/undo`;
      const response = await fetch(path, { method: "POST", headers: { "x-csrf-token": csrfToken } });
      setState(response.ok ? "done" : "error");
    } catch { setState("error"); }
  }
  if (state === "done") return <span className="text-xs text-muted-foreground">Undone</span>;
  return (
    <div className="flex items-center gap-2">
      <Button type="button" size="sm" variant="secondary" disabled={state === "busy"} onClick={undo}>
        {state === "busy" ? "Undoing…" : "Undo"}
      </Button>
      {state === "error" ? <span role="alert" className="text-xs text-danger">Undo failed. Try again.</span> : null}
    </div>
  );
}
