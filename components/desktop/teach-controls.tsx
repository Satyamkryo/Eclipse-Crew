"use client";
import { useState, useEffect } from "react";
import { ModalDialog } from "@/components/workspace/modal-dialog";
import { Circle, Loader2, Pause, Play, Square, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { privacyPauseText, type TeachAction, type TeachCapture, type TeachCaptureSummary } from "@/lib/teach/client";
import { SkillReview } from "@/components/teach/skill-review";

type Props = {
  capture: TeachCapture | null; saved: TeachCaptureSummary[]; busy: boolean; error: string | null; narrationAllowed: boolean; canRecord: boolean;
  onAction: (action: TeachAction, narration?: boolean) => Promise<void>; onRetryTranscription: () => Promise<void>;
};
const utc = (value: string) => value.slice(0, 16).replace("T", " ") + " UTC";
export function TeachControls({ capture, saved, busy, error, canRecord, onAction, onRetryTranscription }: Props) {
  const [review, setReview] = useState<Record<string, unknown> | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [savedOpen, setSavedOpen] = useState(false);
  useEffect(() => {
    if (!reviewId) return;
    let cancelled = false; let reading = false;
    const controller = new AbortController();
    queueMicrotask(() => { if (!cancelled) { setReview(null); setReviewError(null); } });
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const response = await fetch(`/api/teach/${reviewId}`, { cache: "no-store", credentials: "same-origin", signal: controller.signal });
        if (!response.ok) throw new Error();
        const body = await response.json();
        if (!body || typeof body !== "object" || body.captureId !== reviewId) throw new Error();
        if (!cancelled) { setReview(body); setReviewError(null); }
      } catch { if (!cancelled) setReviewError("Could not load the saved recording. Close and try again."); }
      finally { reading = false; }
    };
    void read();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void read(); }, 2000);
    return () => { cancelled = true; controller.abort(); window.clearInterval(timer); };
  }, [reviewId]);
  // Voice narration isn't shipped yet, so recordings are always silent.
  const narration = false;
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const active = capture && ["recording", "paused", "finalizing"].includes(capture.state);
  const seconds = Math.floor((capture?.activeMs ?? 0) / 1000);
  return <section aria-label="Teach recording" className="border-b border-border bg-surface px-3 py-2 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      <span role="status" aria-live="polite" className="flex items-center gap-2">
        <Circle aria-hidden="true" className={`size-4 ${capture?.state === "recording" ? "fill-current motion-safe:animate-pulse" : "text-muted-foreground"}`} />
        {capture?.state === "recording" ? "Recording" : capture?.state === "paused" ? "Recording paused" : capture?.state === "complete" ? "Recording saved" : capture?.state === "finalizing" ? "Saving recording…" : capture?.state === "failed" || capture?.state === "aborted" ? "Recording incomplete" : "Teach from browser"}
      </span>
      {capture && <span className="font-mono tabular-nums text-muted-foreground">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")} · {capture.eventCount} events</span>}
      {!active && <Button size="sm" variant="secondary" disabled={busy || !canRecord} onClick={() => void onAction("start", narration)}>{busy && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}Record</Button>}
      {capture?.state === "recording" && <Button size="sm" variant="secondary" disabled={busy || !canRecord} onClick={() => void onAction("pause")}><Pause aria-hidden="true" className="size-4" />Pause</Button>}
      {capture?.state === "paused" && <Button size="sm" variant="secondary" disabled={busy || !canRecord} onClick={() => void onAction("resume", capture.narration)}><Play aria-hidden="true" className="size-4" />Resume</Button>}
      {active && <Button size="sm" variant="secondary" disabled={busy || capture.state === "finalizing" || !canRecord} onClick={() => void onAction("stop")}><Square aria-hidden="true" className="size-4" />Stop</Button>}
      {capture && capture.state !== "discarded" && <Button size="sm" variant="ghost" disabled={busy || !canRecord} onClick={() => setConfirmDiscard(true)}><Trash2 aria-hidden="true" className="size-4" />Discard</Button>}
      {capture?.state === "complete" && <Button size="sm" variant="secondary" onClick={() => { setReview(null); setReviewError(null); setReviewId(capture.captureId); }}>Review recording</Button>}
      {saved.length > 0 && <Button size="sm" variant="secondary" onClick={() => setSavedOpen(true)}>Saved recordings ({saved.length})</Button>}
      {capture?.state === "complete" && capture.narration && ["pending", "error"].includes(capture.narrationStatus ?? "pending") && <Button size="sm" variant="secondary" disabled={busy} onClick={() => void onRetryTranscription()}>Retry transcription</Button>}
      {capture?.state === "complete" && capture.narration && <span role="status" className="text-muted-foreground">{narrationStatusText(capture.narrationStatus)}</span>}
    </div>
    {capture?.state === "paused" && <p role="status" className="mt-2 text-corona">Needs you: {privacyPauseText(capture.reason)} Resume checks the page again.</p>}
    {error && <p role="alert" className="mt-2 text-danger">{error}</p>}
    {confirmDiscard && <ModalDialog title="Discard recording" description="Discard this recording and its private video, events, screenshots and narration? This cannot be undone." onClose={() => setConfirmDiscard(false)}>
      <div className="mt-2 flex flex-wrap justify-end gap-2"><Button autoFocus size="sm" variant="secondary" onClick={() => setConfirmDiscard(false)}>Keep recording</Button><Button size="sm" variant="destructive" disabled={busy} onClick={() => { setConfirmDiscard(false); void onAction("discard"); }}>Discard recording</Button></div>
    </ModalDialog>}
    {savedOpen && <ModalDialog title="Saved recordings" description="Private managed-browser recordings for this agent. Only you can open them." onClose={() => setSavedOpen(false)}>
      <ul className="mt-2 divide-y divide-border">
        {saved.map((item) => <li key={item.captureId} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <span className="text-sm">{utc(item.createdAt)} · {Math.floor(item.activeMs / 60000)}:{String(Math.floor(item.activeMs / 1000) % 60).padStart(2, "0")} · {item.eventCount} events · {narrationStatusText(item.narrationStatus)}</span>
          <Button size="sm" variant="secondary" aria-label={`Review recording from ${utc(item.createdAt)}`} onClick={() => { setSavedOpen(false); setReview(null); setReviewError(null); setReviewId(item.captureId); }}>Review</Button>
        </li>)}
      </ul>
    </ModalDialog>}
    {reviewId && <ModalDialog title="Review recording" description="Private managed-browser recording. Page targets and narration are untrusted content." onClose={() => setReviewId(null)}>
      {reviewError ? <p role="alert" className="text-sm text-danger">{reviewError}</p> : !review || review.captureId !== reviewId ? <p role="status" className="text-sm text-muted-foreground">Loading recording…</p> : <CaptureReview captureId={reviewId} value={review} />}
    </ModalDialog>}
  </section>;
}

type SafeEvent = { sequence: number; operation: string; offsetMs: number; beforeHash: string; afterHash: string };
type TranscriptTurn = { startMs: number; endMs: number; text: string };
const HASH = /^[0-9a-f]{64}$/;
export function narrationStatusText(status?: string) {
  return ({ off: "Narration off", pending: "Narration awaiting transcription", working: "Transcribing narration…", complete: "Narration transcribed", error: "Transcription needs attention; retry after resolving provider, price or budget settings.", uncertain: "Transcription outcome is uncertain. Automatic retry is disabled to prevent duplicate charges." } as Record<string, string>)[status ?? "off"] ?? "Narration status unavailable";
}
export function CaptureReview({ captureId, value }: { captureId: string; value: Record<string, unknown> }) {
  const manifest = value.manifest && typeof value.manifest === "object" ? value.manifest as Record<string, unknown> : null;
  const artifacts = Array.isArray(value.artifacts) ? value.artifacts as Array<{hash?: string; mime?: string}> : [];
  const allowed = new Set(artifacts.flatMap((item) => typeof item.hash === "string" && HASH.test(item.hash) ? [item.hash] : []));
  const artifact = (hash: unknown) => typeof hash === "string" && HASH.test(hash) && allowed.has(hash) ? `/api/teach/${encodeURIComponent(captureId)}/artifact?hash=${hash}` : null;
  const video = artifact(manifest?.videoHash);
  const events = Array.isArray(manifest?.events) ? manifest.events.filter((item): item is SafeEvent => !!item && typeof item === "object" && Number.isSafeInteger(item.sequence) && Number.isFinite(item.offsetMs) && typeof item.operation === "string").slice(0, 300) : [];
  const audio = Array.isArray(manifest?.audio) ? manifest.audio.filter((item) => item && typeof item === "object" && Number.isFinite(item.offsetMs)).slice(0, 300) : [];
  const turns = Array.isArray(value.narrationSegments) ? value.narrationSegments.flatMap((segment) => segment && typeof segment === "object" && Array.isArray(segment.turns) ? segment.turns.filter((turn: unknown): turn is TranscriptTurn => !!turn && typeof turn === "object" && "startMs" in turn && Number.isFinite(turn.startMs) && "endMs" in turn && Number.isFinite(turn.endMs) && "text" in turn && typeof turn.text === "string" && turn.text.length <= 20000) : []).slice(0, 1000) as TranscriptTurn[] : [];
  return <div className="space-y-4 text-sm">
    {video ? <video aria-label="Recorded managed browser" controls preload="metadata" src={video} className="w-full rounded-md border border-border bg-background"><track kind="captions" /></video> : <p className="text-muted-foreground">No playable video is available in this capture.</p>}
    <p className="text-xs text-muted-foreground">{narrationStatusText(typeof value.narrationStatus === "string" ? value.narrationStatus : undefined)}. Rewind cannot undo external side effects.</p>
    {audio.length > 0 && <ul aria-label="Narration audio segments" className="space-y-3">{audio.map((segment, index) => {
      const url = artifact(segment.hash);
      return url ? <li key={index}><p className="mb-1 font-mono text-xs tabular-nums">{(segment.offsetMs / 1000).toFixed(1)}s</p><audio controls preload="none" src={url} aria-label={`Narration segment ${index + 1}`} className="w-full" /></li> : null;
    })}</ul>}
    {turns.length > 0 && <ol aria-label="Untrusted narration transcript" className="space-y-2">{turns.map((turn, index) => <li key={index} className="flex gap-2"><span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{(turn.startMs / 1000).toFixed(1)}s</span><p className="min-w-0 whitespace-pre-wrap break-words">{turn.text}</p></li>)}</ol>}
    <ol aria-label="Captured events" className="divide-y divide-border">
      {events.map((event) => <li key={event.sequence} className="py-3">
        <p className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs tabular-nums">{(event.offsetMs / 1000).toFixed(1)}s</span><span>{event.operation.startsWith("input.") ? event.operation.slice(0, 64) : "Browser action"}</span></p>
        <div className="mt-2 flex flex-wrap gap-2">{(["beforeHash", "afterHash"] as const).map((key) => {
          const url = artifact(event[key]);
          return url ? <a key={key} href={url} target="_blank" rel="noreferrer" className="text-xs underline underline-offset-4">{key === "beforeHash" ? "Before screenshot" : "After screenshot"}</a> : null;
        })}</div>
      </li>)}
    </ol>
    {events.length === 0 && <p className="text-muted-foreground">No browser actions were captured.</p>}
    <SkillReview captureId={captureId} />
  </div>;
}
