export default function Loading() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-4 py-10 sm:px-6 sm:py-16" aria-busy="true">
      <div className="h-4 w-32 animate-pulse rounded bg-surface-raised" />
      <div className="h-8 w-48 animate-pulse rounded bg-surface-raised" />
      <div className="h-40 animate-pulse rounded-lg border border-border bg-card" />
      <p className="sr-only" role="status">Loading connections…</p>
    </main>
  );
}
