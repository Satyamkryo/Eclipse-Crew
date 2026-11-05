export default function SecurityLoading() {
  return (
    <div className="min-h-dvh bg-background text-foreground" aria-busy="true">
      <div className="border-b border-border px-4 py-6 sm:px-6">
        <div className="mx-auto w-full max-w-6xl">
          <div className="h-4 w-32 animate-pulse rounded bg-accent" />
          <div className="mt-3 h-7 w-56 animate-pulse rounded bg-accent" />
        </div>
      </div>
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
        <div className="h-9 w-64 animate-pulse rounded bg-accent" />
        <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="h-64 animate-pulse rounded-lg bg-accent" />
          <div className="h-64 animate-pulse rounded-lg bg-accent" />
        </div>
        <p role="status" className="sr-only">Loading Security Center</p>
      </div>
    </div>
  );
}
