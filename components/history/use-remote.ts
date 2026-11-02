"use client";
import { useEffect, useRef, useState } from "react";

export type RemoteError = "not_found" | "failed";

// Loads one JSON document and, while `pollMs` returns a number, reloads it on that interval (the open run refreshes while
// it is still running). A failed reload keeps the last good data and shows the error beside it.
export function useRemote<T>(url: string, pollMs: (data: T) => number | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<RemoteError | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const poll = useRef(pollMs);
  useEffect(() => { poll.current = pollMs; });

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!response.ok) { setError(response.status === 404 ? "not_found" : "failed"); setLoading(false); return; }
        const json = (await response.json()) as T;
        if (controller.signal.aborted) return;
        setData(json); setError(null); setLoading(false);
        const next = poll.current(json);
        if (next) timer = setTimeout(() => { void load(); }, next);
      } catch {
        if (controller.signal.aborted) return;
        setError("failed"); setLoading(false);
      }
    };
    void load();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [url, version]);

  return { data, error, loading, reload: () => { setLoading(true); setVersion((value) => value + 1); } };
}
