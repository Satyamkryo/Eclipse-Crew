"use client";

export type TestResult = { models: Array<{ id: string; contextTokens: number | null }>; latencyMs: number };

export function TestOutput({ result, error, loading }: { result: TestResult | null; error: string | null; loading: boolean }) {
  if (loading) {
    return <p role="status" aria-live="polite" className="text-sm text-muted-foreground">Testing the saved provider…</p>;
  }
  if (error) return <p role="alert" className="text-sm text-danger">{error}</p>;
  if (!result) return null;
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">Provider reachable</p>
        <p className="font-mono text-xs tabular-nums text-muted-foreground">{result.latencyMs} ms</p>
      </div>
      {result.models.length === 0 ? (
        <p className="text-sm text-muted-foreground">The provider returned no models.</p>
      ) : (
        <div className="max-h-56 overflow-y-auto border-y border-border">
          <ul aria-label="Available models">
            {result.models.map((model) => (
              <li key={model.id} className="flex min-h-8 flex-wrap items-center justify-between gap-2 border-b border-border px-1 py-1 last:border-b-0">
                <span className="break-all font-mono text-xs">{model.id}</span>
                {model.contextTokens !== null && (
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">{model.contextTokens.toLocaleString("en")} tokens</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
