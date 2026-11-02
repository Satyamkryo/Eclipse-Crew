"use client";

import { useState } from "react";
import { Download, LoaderCircle, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { canOpenOnDesktop } from "@/lib/chat/file-types";

type State = { status: "idle" | "opening" | "opened" | "error"; text?: string };

function openErrorMessage(code: string) {
  if (code === "session_not_running") return "Start this agent's desktop first, then try again.";
  if (code === "takeover_active") return "You're in control of the desktop. Hand it back, then try again.";
  if (code === "file_not_found") return "This file is no longer in the outbox.";
  if (code === "type_blocked") return "This kind of file can only be downloaded.";
  return "Couldn't open this file on the desktop. Try again.";
}

export function FileCardActions({ agentId, messageId, csrfToken, name, kind }: {
  agentId: string; messageId: string; csrfToken: string; name: string; kind: string;
}) {
  const [state, setState] = useState<State>({ status: "idle" });
  const canOpen = canOpenOnDesktop(name, kind);

  async function openOnDesktop() {
    if (state.status === "opening") return;
    setState({ status: "opening" });
    try {
      const response = await fetch(`/api/agents/${agentId}/files/open`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ messageId }),
      });
      if (response.ok) { setState({ status: "opened", text: "Opened in the agent's browser. Watch it in the Desktop tab." }); return; }
      const body = await response.json().catch(() => null) as { error?: unknown } | null;
      setState({ status: "error", text: openErrorMessage(typeof body?.error === "string" ? body.error : "") });
    } catch {
      setState({ status: "error", text: openErrorMessage("") });
    }
  }

  return (
    <div className="mt-4 flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        {canOpen && (
          <Button type="button" variant="secondary" size="sm" onClick={openOnDesktop} disabled={state.status === "opening"}
            aria-label={`Open ${name} on the agent's desktop`}>
            {state.status === "opening" ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> : <Monitor aria-hidden="true" className="size-4" />}
            Open on desktop
          </Button>
        )}
        <Button asChild variant="secondary" size="sm">
          <a href={`/api/agents/${agentId}/files/${messageId}`} download aria-label={`Download ${name}`}>
            <Download aria-hidden="true" className="size-4" />
            Download
          </a>
        </Button>
      </div>
      {state.status === "error" && <p role="alert" className="text-xs text-danger">{state.text}</p>}
      {state.status === "opened" && <p role="status" className="text-xs text-muted-foreground">{state.text}</p>}
    </div>
  );
}
