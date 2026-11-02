"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type PriceRowView = {
  providerId: string;
  providerLabel: string;
  kind: "meta" | "openai-compatible";
  baseUrl: string | null;
  model: string;
  role: "main" | "hard" | "sam" | "custom" | null;
  price: {
    inputMicroUsdPerMillion: number;
    cachedMicroUsdPerMillion: number;
    outputMicroUsdPerMillion: number;
    imageMicroUsdPerThousand: number;
    audioMicroUsdPerHour?: number;
  } | null;
  source: "default" | "override" | "local" | "unpriced";
};

const inputClass = "h-8 w-full min-w-0 rounded-md border border-input bg-surface px-2 font-mono text-xs tabular-nums focus:outline-none focus:ring-2 focus:ring-ring";
const rate = (value: number) => (value / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");

function sourceLabel(source: PriceRowView["source"]) {
  if (source === "override") return "Saved";
  if (source === "local") return "Local · $0";
  if (source === "unpriced") return "Needs price";
  return "Built-in";
}

export function PriceTable({ initial, csrfToken }: { initial: PriceRowView[]; csrfToken: string }) {
  if (initial.length === 0) {
    return <p className="text-sm text-muted-foreground">Save a Main AI model first. Its provider and models will appear here.</p>;
  }
  const providers = [...new Set(initial.map((row) => row.providerLabel))];
  return (
    <div className="flex flex-col gap-4">
      {providers.map((provider) => (
        <div key={provider} className="border-b border-border pb-4 last:border-b-0 last:pb-0">
          <p className="mb-2 font-mono text-xs text-muted-foreground">{provider}</p>
          <div className="mb-1 hidden grid-cols-[minmax(0,1.4fr)_repeat(5,minmax(0,1fr))_auto] gap-2 px-1 text-xs text-muted-foreground md:grid">
            <span>Model</span><span>Input / 1M</span><span>Cached / 1M</span><span>Output / 1M</span><span>Images / 1K</span><span>Audio / hour</span><span>Status</span>
          </div>
          <div className="divide-y divide-border">
            {initial.filter((row) => row.providerLabel === provider).map((row) => (
              <PriceEditorRow key={`${row.providerId}:${row.model}`} row={row} csrfToken={csrfToken} />
            ))}
          </div>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Rates are USD. A hosted model without a price cannot start a run. Local endpoints cost $0. Price changes apply to later calls only.
      </p>
    </div>
  );
}

function PriceEditorRow({ row, csrfToken }: { row: PriceRowView; csrfToken: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const initial = row.price ?? {
    inputMicroUsdPerMillion: 0, cachedMicroUsdPerMillion: 0, outputMicroUsdPerMillion: 0, imageMicroUsdPerThousand: 0, audioMicroUsdPerHour: 0,
  };

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    const form = new FormData(event.currentTarget);
    setState("saving");
    setError(null);
    try {
      const response = await fetch("/api/models/prices", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({
          providerId: row.providerId,
          model: row.model,
          inputPerMillion: form.get("inputPerMillion"),
          cachedPerMillion: form.get("cachedPerMillion"),
          outputPerMillion: form.get("outputPerMillion"),
          imagePerThousand: form.get("imagePerThousand"),
          audioPerHour: form.get("audioPerHour"),
        }),
      });
      if (response.status === 401) { router.push("/login"); router.refresh(); return; }
      if (!response.ok) {
        setError("Couldn't save this price. Check every rate, then try again.");
        return;
      }
      setState("saved");
      router.refresh();
    } catch {
      setError("Unable to connect. Try again.");
    } finally {
      setState((value) => value === "saving" ? "idle" : value);
    }
  }

  return (
    <form onSubmit={save} className="py-2" aria-label={`Prices for ${row.model}`}>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-[minmax(0,1.4fr)_repeat(5,minmax(0,1fr))_auto] md:items-center">
        <div className="col-span-2 min-w-0 md:col-span-1">
          <p className="truncate font-mono text-xs" title={row.model}>{row.model}</p>
          {row.role && <p className="text-xs capitalize text-muted-foreground">{row.role}</p>}
        </div>
        {([
          ["inputPerMillion", "inputMicroUsdPerMillion", "Input per 1M"],
          ["cachedPerMillion", "cachedMicroUsdPerMillion", "Cached per 1M"],
          ["outputPerMillion", "outputMicroUsdPerMillion", "Output per 1M"],
          ["imagePerThousand", "imageMicroUsdPerThousand", "Images per 1K"],
          ["audioPerHour", "audioMicroUsdPerHour", "Audio per hour"],
        ] as const).map(([name, priceKey, label]) => (
          <label key={name} className="flex flex-col gap-1 text-xs text-muted-foreground md:block">
            <span className="md:hidden">{label}</span>
            <input name={name} required inputMode="decimal" pattern="^(?:0|[1-9]\d{0,3})(?:\.\d{1,6})?$"
              defaultValue={rate(row.price?.[priceKey] ?? initial[priceKey] ?? 0)}
              aria-label={`${row.model} ${label} in USD`} className={inputClass} />
          </label>
        ))}
        <div className="col-span-2 flex items-center justify-between gap-2 md:col-span-1 md:justify-end">
          <span className={cn("whitespace-nowrap text-xs", row.source === "unpriced" ? "text-corona" : "text-muted-foreground")}>
            {state === "saved" ? "Saved" : sourceLabel(row.source)}
          </span>
          <Button type="submit" size="sm" variant="secondary" disabled={state === "saving"}>
            {state === "saving" && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
            Save
          </Button>
        </div>
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </form>
  );
}
