"use client";
import { useId, useRef, useState } from "react";
import { Check, Loader2, Play, Repeat2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/workspace/modal-dialog";
import { SkillUpdateReview } from "@/components/heal/skill-update-review";
import { REFUSAL_TEXT, type CompileCodeView, type ReplayScriptView } from "@/lib/replay/view";
import { formatTime } from "./format";
import { useRemote } from "./use-remote";

async function send(url: string, method: "POST" | "DELETE", csrfToken: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  try {
    const response = await fetch(url, {
      method, cache: "no-store", headers: { "x-csrf-token": csrfToken, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: unknown = null;
    try { json = await response.json(); } catch { json = null; }
    return { status: response.status, json };
  } catch {
    return { status: 0, json: null };
  }
}

const reasonText = (code: string) => (code in REFUSAL_TEXT ? REFUSAL_TEXT[code as CompileCodeView] : "This run can't be replayed.");

// On a finished, verified run: turns it into a replay script. Refusals say which step and why, in fixed wording.
export function SaveReplayButton({ runId, csrfToken }: { runId: string; csrfToken: string }) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [reasons, setReasons] = useState<{ step: number | null; code: string }[]>([]);
  const messageRef = useRef<HTMLDivElement>(null);

  async function save() {
    setState("saving");
    setReasons([]);
    const result = await send(`/api/runs/${runId}/replay-script`, "POST", csrfToken, {});
    if (result.status === 200 || result.status === 201) setState("saved");
    else {
      const body = result.json as { reasons?: { step: number | null; code: string }[] } | null;
      setReasons(result.status === 422 && Array.isArray(body?.reasons) ? body.reasons : []);
      setState("error");
    }
    requestAnimationFrame(() => messageRef.current?.focus());
  }

  return (
    <div className="flex flex-col gap-2">
      <Button type="button" variant="secondary" size="sm" disabled={state === "saving" || state === "saved"} onClick={() => void save()}>
        {state === "saving" ? <Loader2 aria-hidden className="size-4 motion-safe:animate-spin" strokeWidth={1.5} />
          : state === "saved" ? <Check aria-hidden className="size-4" strokeWidth={1.5} /> : <Repeat2 aria-hidden className="size-4" strokeWidth={1.5} />}
        {state === "saved" ? "Saved as replay" : "Save as replay"}
      </Button>
      <div ref={messageRef} tabIndex={-1} className="text-xs focus:outline-none" role={state === "error" ? "alert" : "status"}>
        {state === "saved" ? <p className="text-muted-foreground">Saved. Find it under Saved replays in History.</p> : null}
        {state === "error" && reasons.length === 0 ? <p className="text-danger">Couldn&apos;t save this run. Try again.</p> : null}
        {state === "error" && reasons.length > 0 ? (
          <div className="text-danger">
            <p>This run can&apos;t be saved as a replay:</p>
            <ul className="mt-1 list-disc pl-4">
              {reasons.map((reason, i) => <li key={i}>{reason.step !== null ? `Step ${reason.step}: ` : ""}{reasonText(reason.code)}</li>)}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ReplayRow({ script, agentId, csrfToken, timeZone, onChanged }: { script: ReplayScriptView; agentId: string; csrfToken: string; timeZone: string; onChanged: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const idPrefix = useId();
  const needing = script.steps.filter((step) => step.needsText);
  const ready = needing.every((step) => (values[String(step.idx)] ?? "").length > 0);

  async function replay() {
    if (!ready || busy) return;
    setBusy(true);
    setMessage(null);
    const inputs = Object.fromEntries(needing.map((step) => [String(step.idx), values[String(step.idx)] ?? ""]));
    const result = await send(`/api/replay-scripts/${script.id}/run`, "POST", csrfToken, { inputs });
    setBusy(false);
    if (result.status === 202) {
      // The typed text has been sent; it is not kept in the page either.
      setValues({});
      setMessage({ tone: "ok", text: "Started. The result appears in chat and under Runs." });
    } else if (result.status === 409) setMessage({ tone: "error", text: "This agent is paused. Resume it, then try again." });
    else if (result.status === 404) { setMessage({ tone: "error", text: "This replay no longer exists." }); onChanged(); }
    else if (result.status === 400) setMessage({ tone: "error", text: "Check the text you entered for each step." });
    else setMessage({ tone: "error", text: "Couldn't start the replay. Try again." });
  }

  return (
    <li className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">{script.name}</p>
          <p className="mt-0.5 text-xs text-text-subtle tabular-nums">v{script.version} · {script.stepCount} {script.stepCount === 1 ? "step" : "steps"} · {formatTime(script.createdAt, timeZone)}</p>
        </div>
        {script.pendingProposalId && (
          <span className="rounded-md bg-corona/12 px-2 py-0.5 text-xs text-corona">Update proposed</span>
        )}
        {script.pendingProposalId && (
          <Button type="button" size="sm" variant="secondary" onClick={() => setReviewing(script.pendingProposalId)}>Review update</Button>
        )}
        <Button type="button" size="sm" variant="secondary" disabled={!ready || busy} onClick={() => void replay()}>
          {busy ? <Loader2 aria-hidden className="size-4 motion-safe:animate-spin" strokeWidth={1.5} /> : <Play aria-hidden className="size-4" strokeWidth={1.5} />}
          Replay
        </Button>
        <Button type="button" size="sm" variant="ghost" aria-label={`Delete replay ${script.name}`} title="Delete replay" onClick={() => setConfirmingDelete(true)}>
          <Trash2 aria-hidden className="size-4" strokeWidth={1.5} />
        </Button>
      </div>
      {needing.map((step) => (
        <div key={step.idx} className="flex flex-col gap-1">
          <label htmlFor={`${idPrefix}-${step.idx}`} className="text-xs text-muted-foreground">Text to type in step {step.idx} (not saved)</label>
          <input id={`${idPrefix}-${step.idx}`} value={values[String(step.idx)] ?? ""} maxLength={2000} autoComplete="off" spellCheck={false}
            onChange={(event) => setValues((current) => ({ ...current, [String(step.idx)]: event.target.value }))}
            className="h-8 rounded-md border border-input bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
      ))}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer rounded-md py-1 focus-visible:outline-2 focus-visible:outline-ring">Review steps</summary>
        <ol className="mt-1 list-decimal pl-5">
          {script.steps.map((step) => <li key={step.idx} className="break-words py-0.5">{step.text}</li>)}
        </ol>
      </details>
      {message ? <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "text-xs text-danger" : "text-xs text-muted-foreground"}>{message.text}</p> : null}
      {confirmingDelete ? (
        <DeleteDialog script={script} agentId={agentId} csrfToken={csrfToken} onClose={() => setConfirmingDelete(false)} onDeleted={onChanged} />
      ) : null}
      {reviewing ? (
        <ModalDialog title="Review skill update" description={`${script.name} · review the proposed repair before it changes this replay.`} onClose={() => setReviewing(null)}>
          <SkillUpdateReview proposalId={reviewing} csrfToken={csrfToken} onDecided={onChanged} />
        </ModalDialog>
      ) : null}
    </li>
  );
}

function DeleteDialog({ script, csrfToken, onClose, onDeleted }: { script: ReplayScriptView; agentId: string; csrfToken: string; onClose: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  async function remove() {
    setBusy(true);
    setError(false);
    const result = await send(`/api/replay-scripts/${script.id}`, "DELETE", csrfToken);
    setBusy(false);
    if (result.status === 200 || result.status === 404) { onClose(); onDeleted(); } else setError(true);
  }
  return (
    <ModalDialog title={`Delete “${script.name}”?`} onClose={onClose}
      description="This removes the saved replay only. The run it came from, and its proof, stay in History.">
      <div className="flex flex-col gap-4">
        {error ? <p role="alert" className="text-sm text-danger">Couldn&apos;t delete this replay. Try again.</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void remove()}>
            {busy ? <Loader2 aria-hidden className="size-3.5 motion-safe:animate-spin" /> : null}
            Delete replay
          </Button>
        </div>
      </div>
    </ModalDialog>
  );
}

// "Saved replays" at the top of History. Shows nothing while the agent has none (the Save button on a verified run explains how).
export function ReplaySection({ agentId, csrfToken, timeZone }: { agentId: string; csrfToken: string; timeZone: string }) {
  const { data, error, loading, reload } = useRemote<{ scripts: ReplayScriptView[] }>(`/api/agents/${agentId}/replay-scripts`, () => null);
  if (loading && !data) return <p role="status" className="border-b border-border px-4 py-3 text-xs text-muted-foreground">Loading saved replays…</p>;
  if (error && !data) {
    return (
      <div role="alert" className="flex items-center gap-3 border-b border-border px-4 py-3">
        <p className="text-xs text-danger">Saved replays could not be loaded.</p>
        <button type="button" onClick={reload} className="text-xs underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">Try again</button>
      </div>
    );
  }
  if (!data?.scripts.length) return null;
  return (
    <section aria-label="Saved replays" className="border-b border-border">
      <h3 className="px-4 pt-4 text-sm font-semibold tracking-tight">Saved replays</h3>
      <p className="px-4 pt-1 text-xs text-text-subtle">Replays click the same controls without a second check by a model. Review the steps first.</p>
      <ul className="mt-2 divide-y divide-border">
        {data.scripts.map((script) => <ReplayRow key={script.id} script={script} agentId={agentId} csrfToken={csrfToken} timeZone={timeZone} onChanged={reload} />)}
      </ul>
    </section>
  );
}
