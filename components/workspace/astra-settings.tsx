"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, LoaderCircle, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/workspace/modal-dialog";

const CHECKS = [
  "Signed receipts and audit records remain active.",
  "Daily and monthly budgets still apply.",
  "Isolated desktop and filesystem remain enforced.",
  "Security tripwire can still stop the agent.",
  "Actions outside the agent's allowed list are still denied.",
] as const;

export function AstraSettings({ agentId, agentName, astraMode, csrfToken }: {
  agentId: string; agentName: string; astraMode: boolean; csrfToken: string;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(astraMode);
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function save(next: boolean) {
    if (loading) return;
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const response = await fetch(`/api/agents/${agentId}/astra`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(next ? { enabled: true, acknowledged: true } : { enabled: false }),
      });
      if (response.status === 401) {
        router.push("/login");
        router.refresh();
        return;
      }
      if (!response.ok) {
        setError(response.status === 400
          ? "Astra Mode needs the warning to be acknowledged."
          : "Couldn't change Astra Mode. Try again.");
        return;
      }
      setEnabled(next);
      setConfirming(false);
      setStatus(next
        ? "Astra Mode is on. Risky actions now run without an approval prompt."
        : "Astra Mode is off. Risky actions ask for approval again.");
      router.refresh();
    } catch {
      setError("Unable to connect. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Advanced safety</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Astra Mode removes action approval prompts only. Every other safety layer stays on.
          </p>
          <p className="mt-2 text-sm">
            <span className={`font-semibold ${enabled ? "text-destructive" : ""}`}>Astra Mode is {enabled ? "on" : "off"}.</span>
          </p>
        </div>
        <Button type="button" variant={enabled ? "secondary" : "destructive"} disabled={loading}
          onClick={() => { if (enabled) void save(false); else setConfirming(true); }}>
          {loading && !confirming && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
          {enabled ? "Disable Astra Mode" : "Enable Astra Mode"}
        </Button>
      </div>
      <p role="status" aria-live="polite" className="mt-3 min-h-5 text-sm text-muted-foreground">{status}</p>
      {error && <p role="alert" className="mt-1 text-sm text-danger">{error}</p>}
      {confirming && (
        <AstraDialog agentName={agentName} loading={loading}
          onCancel={() => { if (!loading) setConfirming(false); }}
          onEnable={() => void save(true)} />
      )}
    </section>
  );
}

function AstraDialog({ agentName, loading, onCancel, onEnable }: {
  agentName: string; loading: boolean; onCancel: () => void; onEnable: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  // ModalDialog focuses its close button first; move focus to Cancel after that effect has run.
  useEffect(() => {
    const frame = requestAnimationFrame(() => cancel.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <ModalDialog title="Enable Astra Mode?" onClose={onCancel}>
      <div className="flex flex-col gap-4">
        <p className="flex items-start gap-2 text-sm font-semibold">
          <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span>Astra Mode removes action approval prompts for {agentName}.</span>
        </p>
        <ul className="flex flex-col gap-2 text-sm">
          {CHECKS.map((line) => (
            <li key={line} className="flex items-start gap-2">
              <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
              <span className="min-w-0">{line}</span>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">
          Enable only when you trust this agent&apos;s permissions and allowed domains. You can turn Astra Mode off later.
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button ref={cancel} type="button" variant="secondary" disabled={loading} onClick={onCancel}>Cancel</Button>
          <Button type="button" variant="destructive" disabled={loading} onClick={onEnable} aria-busy={loading}>
            {loading && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
            Enable Astra Mode
          </Button>
        </div>
      </div>
    </ModalDialog>
  );
}
