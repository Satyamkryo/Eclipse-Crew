export default function JobsLoading() {
  return (
    <div className="min-h-dvh bg-background text-foreground" aria-busy="true">
      <div className="border-b border-border px-4 py-6 sm:px-6">
        <div className="mx-auto w-full max-w-6xl">
          <div className="h-4 w-32 animate-pulse rounded bg-accent" />
          <div className="mt-3 h-7 w-24 animate-pulse rounded bg-accent" />
        </div>
      </div>
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
        <div className="h-9 w-64 animate-pulse rounded bg-accent" />
        <div className="mt-4 h-64 animate-pulse rounded-lg bg-accent" />
        <p role="status" className="sr-only">Loading jobs</p>
      </div>
    </div>
  );
}
