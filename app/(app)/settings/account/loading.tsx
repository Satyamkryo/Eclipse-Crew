export default function Loading() {
  return (
    <main aria-busy="true" aria-label="Loading account settings" className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-16">
      <div className="h-3 w-32 animate-pulse rounded-md bg-accent" />
      <div className="h-8 w-40 animate-pulse rounded-md bg-accent" />
      {[0, 1, 2].map((item) => (
        <div key={item} className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
          <div className="h-5 w-40 animate-pulse rounded-md bg-accent" />
          <div className="h-8 w-full animate-pulse rounded-md bg-accent" />
          <div className="h-8 w-full animate-pulse rounded-md bg-accent" />
        </div>
      ))}
    </main>
  );
}
