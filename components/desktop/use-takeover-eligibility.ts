"use client";
import { useCallback, useSyncExternalStore } from "react";

// Takeover eligibility is an input-policy check, not hardware attestation and not a server
// authorization boundary (docs/SECURITY.md; the owner/lease/CSRF guards stay authoritative).
//
// Rule (docs/DESIGN.md; approved prompt 2026-11-03-ui-reference-alignment.md):
// - Start view-only. `(any-pointer: fine)` is only a capability hint.
// - Take over unlocks only after, in this viewer session: one trusted mouse pointer action
//   AND one trusted non-composing keyboard event, both collected on the takeover control
//   itself. The check never forwards events to the desktop, never stores key values, and
//   never grants a lease by itself. It is an input check, never proof of attached hardware.
// - Touch-only devices (any width) stay view-only; mouse-only and keyboard-only do not pass.
// - Evidence resets on stream loss, page resume and observable capability loss; while a
//   takeover is active a loss blocks new and queued input and releases the lease (LiveView).
//
// State is module-level so the inline frame, the expanded view and the teach controls share
// one eligibility without prop drilling.

type Evidence = { pointer: boolean; keyboard: boolean; hint: boolean };

let evidence: Evidence = { pointer: false, keyboard: false, hint: false };
const listeners = new Set<() => void>();
let initialized = false;

function emit() {
  for (const listener of listeners) listener();
}

function setState(patch: Partial<Evidence>) {
  const next = { ...evidence, ...patch };
  if (next.pointer === evidence.pointer && next.keyboard === evidence.keyboard && next.hint === evidence.hint) return;
  evidence = next;
  emit();
}

/** Registers the capability hint and the reset-on-loss listeners. Idempotent; client-only. */
export function initTakeoverEligibility(): () => void {
  if (typeof window === "undefined" || initialized) return () => {};
  initialized = true;
  const query = window.matchMedia("(any-pointer: fine)");
  setState({ hint: query.matches });
  const onHint = () => {
    // Observable capability loss resets the evidence immediately.
    if (!query.matches) resetTakeoverEvidence();
    setState({ hint: query.matches });
  };
  query.addEventListener("change", onHint);
  const onVisibility = () => {
    // Page resume requires the owner to re-confirm the check (fresh evidence).
    if (document.visibilityState === "hidden") resetTakeoverEvidence();
  };
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    query.removeEventListener("change", onHint);
    document.removeEventListener("visibilitychange", onVisibility);
    initialized = false;
  };
}

export function resetTakeoverEvidence() {
  setState({ pointer: false, keyboard: false });
}

/** Synchronous eligibility read for event handlers that must not wait for a re-render. */
export function isTakeoverEligible(): boolean {
  return evidence.pointer && evidence.keyboard;
}

/** Records a trusted mouse pointer action. Returns true when it counted as evidence. */
export function confirmPointerEvidence(event: {
  isTrusted?: boolean;
  pointerType?: string;
  button?: number;
}): boolean {
  if (!event.isTrusted) return false;
  if (event.pointerType !== "mouse") return false;
  if (event.button !== 0) return false;
  setState({ pointer: true });
  return true;
}

/** Records a trusted, non-composing keyboard event. Returns true when it counted. */
export function confirmKeyboardEvidence(event: {
  isTrusted?: boolean;
  isComposing?: boolean;
  key?: string;
}): boolean {
  if (!event.isTrusted) return false;
  if (event.isComposing) return false;
  const key = event.key ?? "";
  // Modifier presses alone are not usable typing evidence.
  if (!key || ["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(key)) return false;
  setState({ keyboard: true });
  return true;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): Evidence {
  return evidence;
}

export type TakeoverEligibility = {
  /** True only after demonstrated trusted mouse AND trusted keyboard input this session. */
  eligible: boolean;
  hint: boolean;
  pointerConfirmed: boolean;
  keyboardConfirmed: boolean;
  confirmPointer: typeof confirmPointerEvidence;
  confirmKeyboard: typeof confirmKeyboardEvidence;
  reset: typeof resetTakeoverEvidence;
};

export function useTakeoverEligibility(): TakeoverEligibility {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    eligible: snapshot.pointer && snapshot.keyboard,
    hint: snapshot.hint,
    pointerConfirmed: snapshot.pointer,
    keyboardConfirmed: snapshot.keyboard,
    confirmPointer: confirmPointerEvidence,
    confirmKeyboard: confirmKeyboardEvidence,
    reset: resetTakeoverEvidence,
  };
}

/** Stable event-handler helpers for the takeover control (React synthetic events). */
export function useTakeoverEvidenceHandlers() {
  const eligibility = useTakeoverEligibility();
  const onPointerDown = useCallback((event: React.PointerEvent) => {
    eligibility.confirmPointer({ isTrusted: event.nativeEvent.isTrusted, pointerType: event.pointerType, button: event.button });
  }, [eligibility]);
  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    eligibility.confirmKeyboard({ isTrusted: event.nativeEvent.isTrusted, isComposing: event.nativeEvent.isComposing, key: event.key });
  }, [eligibility]);
  return { eligibility, onPointerDown, onKeyDown };
}
