"use client";

import { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { Globe, LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";

// Shown when this browser's timezone differs from the owner's saved one. Nothing changes until the owner chooses:
// schedules, budgets and agent clocks all use the saved zone, so a trip or a VPN must never move them silently.
// "Keep" is remembered on this device for this exact saved/detected pair, so a later change asks again.
const KEEP_KEY = "eclipse-crew.timezone-keep";
const noSubscribe = () => () => {};

function browserZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; }
}

function readKept(): string | null {
  try { return window.localStorage.getItem(KEEP_KEY); } catch { return null; }
}

// The notice shows only when the browser reports a zone, it differs from the saved one, and the owner has not chosen
// "Keep" for this exact saved/detected pair (on this device, or in this visit).
export function timezonePromptKey(savedZone: string, detected: string, kept: string | null, dismissed: string | null): string | null {
  if (!detected || detected === savedZone) return null;
  const pair = `${savedZone}|${detected}`;
  return kept === pair || dismissed === pair ? null : pair;
}

export function TimezoneNotice({ savedZone, csrfToken }: { savedZone: string; csrfToken: string }) {
  const router = useRouter();
  // Server render has no browser zone, so the notice only ever appears after hydration (no mismatch).
  const detected = useSyncExternalStore(noSubscribe, browserZone, () => "");
  const keptOnDevice = useSyncExternalStore(noSubscribe, readKept, () => null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const promptKey = timezonePromptKey(savedZone, detected, keptOnDevice, dismissed);
  if (!promptKey) return null;
  const pair: string = promptKey;

  function keep() {
    try { window.localStorage.setItem(KEEP_KEY, pair); } catch { /* still hidden for this visit */ }
    setDismissed(pair);
  }

  async function applyDetected() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/account/timezone", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ timezone: detected }),
      });
      if (response.status === 401) { router.push("/login"); return; }
      if (!response.ok) {
        setError(`${detected} isn't supported. Pick a timezone on your Profile.`);
        return;
      }
      setDismissed(pair);
      router.refresh();
    } catch {
      setError("Unable to connect. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-label="Timezone" className="shrink-0 border-b border-border bg-corona/12 px-4 py-2 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="flex min-w-0 flex-1 items-start gap-2 text-sm">
          <Globe aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-corona" strokeWidth={1.5} />
          <span>
            This device is in <strong className="font-medium">{detected}</strong>. Schedules and budgets use{" "}
            <strong className="font-medium">{savedZone}</strong>.
          </span>
        </p>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button type="button" size="sm" disabled={saving} onClick={() => void applyDetected()}>
            {saving && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
            Use {detected}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={keep}>Keep {savedZone}</Button>
        </div>
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  );
}
