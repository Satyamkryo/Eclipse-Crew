"use client";
import { useSyncExternalStore } from "react";

// Take over is one click and Hand back is one click. The only client-side rule left is that
// touch-only devices stay view-only, because the remote desktop is driven by a real mouse
// pointer. This is a UI hint, never an authorization boundary: the server's owner, CSRF and
// lease checks stay authoritative (docs/SECURITY.md).
const QUERY = "(any-pointer: fine)";

function subscribe(listener: () => void) {
  if (typeof window === "undefined") return () => {};
  const query = window.matchMedia(QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

function getSnapshot(): boolean {
  return typeof window !== "undefined" && window.matchMedia(QUERY).matches;
}

/** True when this device has a fine (mouse-like) pointer that can drive the desktop. */
export function useTakeoverAvailable(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
