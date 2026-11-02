"use client";

import { useEffect, useRef, useState } from "react";

export type TeachLease = { generation: string; connectionId: string; leaseId: string };
export type TeachSession = { lease: TeachLease | null; csrfToken: string; disposed: boolean };
export type TeachCapture = {
  captureId: string; state: "recording" | "paused" | "finalizing" | "complete" | "failed" | "aborted" | "discarded";
  reason?: string; activeMs: number; eventCount: number; narration: boolean; narrationStatus?: string;
  manifest?: unknown;
};
export type TeachAction = "start" | "status" | "pause" | "resume" | "stop" | "discard";
export type TeachCaptureSummary = { captureId: string; state: "complete"; activeMs: number; eventCount: number;
  narration: boolean; narrationStatus: string; createdAt: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NARRATION = ["off", "pending", "working", "complete", "error", "uncertain"];
const SUMMARY_KEYS = new Set(["captureId", "state", "activeMs", "eventCount", "narration", "narrationStatus", "createdAt"]);
export function privacyPauseText(reason?: string) {
  const known: Record<string, string> = {
    owner_pause: "You paused recording.", manual: "You paused recording.",
    sensitive_surface: "A sensitive browser surface needs your attention.",
    sensitive_target: "A sensitive browser field needs your attention.",
    unsupported_surface: "This surface cannot be recorded safely.",
    unsupported_page: "This page cannot be recorded safely.",
  };
  return known[reason ?? ""] ?? "Recording paused for privacy. Check the managed browser before resuming.";
}
export function parseTeachCapture(value: unknown): TeachCapture {
  if (!value || typeof value !== "object") throw new Error("Recording status could not be confirmed.");
  const v = value as Record<string, unknown>;
  if (typeof v.captureId !== "string" || !UUID.test(v.captureId) ||
      !["recording", "paused", "finalizing", "complete", "failed", "aborted", "discarded"].includes(String(v.state)) ||
      !Number.isSafeInteger(v.activeMs) || (v.activeMs as number) < 0 || (v.activeMs as number) > 120000 || !Number.isSafeInteger(v.eventCount) || (v.eventCount as number) < 0 || (v.eventCount as number) > 300 || typeof v.narration !== "boolean") {
    throw new Error("Recording status could not be confirmed.");
  }
  return { captureId: v.captureId, state: v.state as TeachCapture["state"], activeMs: v.activeMs as number, eventCount: v.eventCount as number,
    narration: v.narration, reason: typeof v.reason === "string" ? v.reason : undefined,
    narrationStatus: typeof v.narrationStatus === "string" ? v.narrationStatus : undefined, manifest: v.manifest };
}
export function parseTeachCaptureList(value: unknown): TeachCaptureSummary[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error("Saved recordings could not be confirmed.");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Object.keys(item).some((key) => !SUMMARY_KEYS.has(key))) throw new Error("Saved recordings could not be confirmed.");
    const v = item as Record<string, unknown>;
    if (typeof v.captureId !== "string" || !UUID.test(v.captureId) || v.state !== "complete" ||
      !Number.isSafeInteger(v.activeMs) || (v.activeMs as number) < 0 || (v.activeMs as number) > 120000 ||
      !Number.isSafeInteger(v.eventCount) || (v.eventCount as number) < 0 || (v.eventCount as number) > 300 ||
      typeof v.narration !== "boolean" || !NARRATION.includes(String(v.narrationStatus)) ||
      typeof v.createdAt !== "string" || v.createdAt.length > 40 || Number.isNaN(Date.parse(v.createdAt))) throw new Error("Saved recordings could not be confirmed.");
    return { captureId: v.captureId, state: "complete", activeMs: v.activeMs as number, eventCount: v.eventCount as number,
      narration: v.narration, narrationStatus: v.narrationStatus as string, createdAt: v.createdAt };
  });
}
async function jsonRequest(url: string, csrfToken: string, body: unknown) {
  const response = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("Recording request was denied or could not finish. Check the desktop and try again.");
  return response.json();
}
const activeCapture = (capture: TeachCapture | null) => capture && ["recording", "paused", "finalizing"].includes(capture.state);

// Owned by LiveView, not either toolbar: expansion never restarts the capture or microphone.
export function useTeachCapture(agentId: string, getSession: () => TeachSession | null, available: boolean) {
  const [capture, setCapture] = useState<TeachCapture | null>(null);
  const [saved, setSaved] = useState<TeachCaptureSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [narrationAllowed, setNarrationAllowed] = useState(false);
  const current = useRef<TeachCapture | null>(null);
  const mic = useRef<{ stream: MediaStream; recorder: MediaRecorder | null; epoch: number; stoppingAt?: number } | null>(null);
  const sequence = useRef(0);
  const clockAt = useRef(0);
  const queuedSegments = useRef(0);
  const operation = useRef(false);
  const revision = useRef(0);
  const mounted = useRef(true);
  const availableRef = useRef(available);
  const uploadQueue = useRef(Promise.resolve());
  const stopMic = () => {
    const device = mic.current;
    mic.current = null;
    if (device) { device.epoch++; device.stream.getTracks().forEach((track) => track.stop()); if (device.recorder?.state !== "inactive") device.recorder?.stop(); }
  };
  const apply = (next: TeachCapture) => {
    const previous = current.current;
    current.current = next;
    clockAt.current = performance.now();
    if (next.state !== "recording") stopMic();
    if (mounted.current) setCapture(next);
    if (next.state === "paused" && previous?.state !== "paused") window.dispatchEvent(new CustomEvent("teach-privacy-pause", { detail: { agentId, captureId: next.captureId } }));
  };
  const command = async (action: TeachAction, narration = false) => {
    const session = getSession();
    if (!session?.lease || session.disposed) throw new Error("Take over the live desktop before recording.");
    const lease = session.lease;
    const version = action === "status" ? revision.current : ++revision.current;
    const next = parseTeachCapture(await jsonRequest(`/api/desktop/${agentId}/teach`, session.csrfToken,
      { ...session.lease, action, ...(action === "start" ? { narration } : { captureId: current.current?.captureId }) }));
    if (getSession()?.lease !== lease || session.disposed) throw new Error("Recording control expired. Take over again to check its saved state.");
    if (version !== revision.current) return current.current ?? next;
    apply(next); return next;
  };
  const refreshSaved = async (captureId: string) => {
    const response = await fetch(`/api/teach/${captureId}`, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("Saved recording status could not be loaded.");
    const saved = parseTeachCapture(await response.json());
    if (mounted.current && saved.captureId === captureId && current.current?.captureId === captureId) apply(saved);
  };
  const loadSaved = async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`/api/desktop/${agentId}/teach`, { cache: "no-store", signal });
      if (!response.ok || !mounted.current) return;
      const body = await response.json();
      if (!mounted.current) return;
      setNarrationAllowed(body?.narrationAllowed === true);
      setSaved(parseTeachCaptureList(body?.captures));
    } catch { if (mounted.current) setSaved([]); }
  };
  // Each segment is a complete, independently decodable file. Never upload an unconfirmed interval.
  const startMic = async (stream: MediaStream) => {
    const device = { stream, recorder: null as MediaRecorder | null, epoch: 0, stoppingAt: undefined as number | undefined };
    mic.current = device;
    const recordSegment = () => {
      const captured = current.current;
      if (mic.current !== device || captured?.state !== "recording" || !stream.active) return;
      const epoch = device.epoch;
      const offsetMs = Math.round(captured.activeMs + Math.max(0, performance.now() - clockAt.current));
      let recorder: MediaRecorder;
      try { recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 64000 }); }
      catch { stopMic(); if (mounted.current) setError("Microphone recording stopped. Silent browser recording can continue."); return; }
      device.recorder = recorder;
      recorder.onerror = () => { stopMic(); if (mounted.current) setError("Microphone recording stopped. Silent browser recording can continue."); };
      const pieces: BlobPart[] = [];
      let bytes = 0;
      recorder.ondataavailable = (event) => { bytes += event.data.size; if (bytes <= 3 * 1024 * 1024) pieces.push(event.data); };
      recorder.onstop = () => {
        if (mic.current !== device || device.epoch !== epoch || device.stoppingAt !== undefined || current.current?.state !== "recording" || bytes > 3 * 1024 * 1024) return;
        if (queuedSegments.current >= 3) { stopMic(); if (mounted.current) setError("Narration stopped because uploads could not keep up. Silent recording can continue."); return; }
        queuedSegments.current++;
        const eligibleAt = performance.now() + 2000;
        const blob = new Blob(pieces, { type: "audio/webm;codecs=opus" });
        uploadQueue.current = uploadQueue.current.then(async () => {
          if (device.stoppingAt !== undefined && eligibleAt > device.stoppingAt) return;
          await new Promise<void>((resolve) => window.setTimeout(resolve, Math.max(0, eligibleAt - performance.now())));
          if (device.stoppingAt !== undefined && eligibleAt > device.stoppingAt) return;
          if (mic.current !== device || epoch !== device.epoch || current.current?.state !== "recording") return;
          const confirmed = await command("status");
          // A pause/resume discontinuity or stale clock discards the entire uncertain segment.
          const endMs = offsetMs + 2000;
          if (confirmed.state !== "recording" || confirmed.activeMs + 100 < endMs || confirmed.activeMs - endMs > 6000) return;
          const session = getSession();
          if (!session?.lease || session.disposed || mic.current !== device || epoch !== device.epoch) return;
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
          if (mic.current !== device || epoch !== device.epoch) return;
          await jsonRequest(`/api/teach/${confirmed.captureId}/narration`, session.csrfToken, { ...session.lease, sequence: sequence.current, offsetMs, mime: blob.type, base64: btoa(binary) });
          sequence.current++;
        }).catch(() => { stopMic(); if (mounted.current) setError("Narration stopped because its safe timing could not be confirmed. Silent browser recording can continue."); }).finally(() => { queuedSegments.current--; });
        if (mic.current === device && current.current?.state === "recording") window.setTimeout(recordSegment, 100);
      };
      recorder.start();
      window.setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 2000);
    };
    recordSegment();
  };
  const act = async (action: TeachAction, narration = false) => {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(null);
    let stream: MediaStream | null = null;
    try {
      const initiatingLease = getSession()?.lease;
      // This path runs only from an explicit Record/Resume click with the checkbox selected.
      if ((action === "start" || action === "resume") && narration && narrationAllowed) {
        if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) throw new Error("Microphone recording is unavailable in this browser. Turn off narration to record silently.");
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        if (!mounted.current || !availableRef.current || document.visibilityState !== "visible" || !initiatingLease || getSession()?.lease !== initiatingLease) { stream.getTracks().forEach((track) => track.stop()); return; }
      }
      if (action === "stop" && mic.current) {
        const device = mic.current;
        device.stoppingAt = performance.now();
        device.stream.getTracks().forEach((track) => track.stop());
        if (device.recorder?.state !== "inactive") device.recorder?.stop();
        // Commit only segments already past the privacy hold when Stop was pressed.
        // The incomplete tail and newer held intervals are discarded.
        await uploadQueue.current;
      }
      if (["pause", "stop", "discard"].includes(action)) stopMic();
      if (action === "start") { await uploadQueue.current; sequence.current = 0; }
      const next = await command(action, narration && narrationAllowed);
      if (stream && next.state === "recording") { await startMic(stream); stream = null; }
      if (action === "stop" && next.narration) {
        await uploadQueue.current;
        const session = getSession();
        if (session && next.state === "complete") {
          try {
            const transcribed = parseTeachCapture(await jsonRequest(`/api/teach/${next.captureId}/narration`, session.csrfToken, { action: "transcribe" }));
            if (mounted.current && current.current?.captureId === transcribed.captureId) apply(transcribed);
          } catch { throw new Error("Recording saved. Narration has not been confirmed. Open review for its current status; retry only when offered.");
          } finally { await refreshSaved(next.captureId); }
        }
      }
    } catch (failure) { stopMic(); if (mounted.current) setError(failure instanceof Error ? failure.message : "Recording could not finish."); }
    finally { stream?.getTracks().forEach((track) => track.stop()); operation.current = false; if (mounted.current) { setBusy(false); void loadSaved(); } }
  };
  const retryTranscription = async () => {
    const session = getSession(); const saved = current.current;
    if (!session || !saved || operation.current) return;
    operation.current = true; setBusy(true); setError(null);
    try {
      const transcribed = parseTeachCapture(await jsonRequest(`/api/teach/${saved.captureId}/narration`, session.csrfToken, { action: "transcribe" }));
      if (mounted.current && current.current?.captureId === transcribed.captureId) apply(transcribed);
    }
    catch { if (mounted.current) setError("Transcription has not been confirmed. The recording is retained. Open review for its current status."); }
    finally { await refreshSaved(saved.captureId).catch(() => {}); operation.current = false; if (mounted.current) { setBusy(false); void loadSaved(); } }
  };
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    current.current = null; sequence.current = 0; revision.current++;
    queueMicrotask(() => { if (!cancelled) { setCapture(null); setSaved([]); setError(null); setNarrationAllowed(false); } });
    const listController = new AbortController();
    queueMicrotask(() => { if (!cancelled) void loadSaved(listController.signal); });
    const onHide = () => stopMic();
    window.addEventListener("pagehide", onHide);
    const visibility = () => { if (document.visibilityState !== "visible") { stopMic(); if (current.current?.state === "recording") void command("pause").catch(() => {}); } };
    document.addEventListener("visibilitychange", visibility);
    return () => { cancelled = true; mounted.current = false; listController.abort(); stopMic(); window.removeEventListener("pagehide", onHide); document.removeEventListener("visibilitychange", visibility); };
    // The connection getter is stable and intentionally reads the current lease.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);
  useEffect(() => {
    availableRef.current = available;
    if (!available) {
      stopMic();
      if (current.current?.state === "recording" && getSession()?.lease) void command("pause").catch(() => {});
      return;
    }
    let polling = false; let cancelled = false;
    const timer = window.setInterval(() => {
      if (!activeCapture(current.current) || polling || operation.current) return;
      polling = true;
      void command("status").catch(() => { stopMic(); if (!cancelled) setError("Recording status is uncertain. Microphone stopped. Check the desktop before continuing."); }).finally(() => { polling = false; });
    }, 500);
    return () => { cancelled = true; window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, agentId]);
  useEffect(() => {
    if (capture?.state !== "complete" || !capture.narration || !["pending", "working"].includes(capture.narrationStatus ?? "")) return;
    const captureId = capture.captureId;
    let reading = false;
    const timer = window.setInterval(() => {
      if (reading || document.visibilityState !== "visible") return;
      reading = true;
      // Read status only; a timed-out transcription is never silently resubmitted.
      void refreshSaved(captureId).catch(() => {}).finally(() => { reading = false; });
    }, 2000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture?.captureId, capture?.state, capture?.narration, capture?.narrationStatus]);
  return { capture, saved, busy, error, narrationAllowed, act, stopMic, retryTranscription };
}
