import Link from "next/link";

export default function LoadingModels() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-4 py-10 sm:px-6 sm:py-16" aria-busy="true" aria-label="Loading model settings">
      <Link href="/" className="text-sm underline underline-offset-4">Back to workspace</Link>
      <div className="h-8 w-32 rounded-md bg-accent animate-pulse [animation-duration:1.5s]" />
      <div className="h-4 w-full max-w-xl rounded-md bg-accent animate-pulse [animation-duration:1.5s]" />
      {[0, 1].map((card) => (
        <section key={card} className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
          <div className="h-5 w-36 rounded-md bg-accent animate-pulse [animation-duration:1.5s]" />
          <div className="h-4 w-3/4 rounded-md bg-accent animate-pulse [animation-duration:1.5s]" />
          <div className="h-8 w-full rounded-md bg-accent animate-pulse [animation-duration:1.5s]" />
          <div className="h-8 w-full rounded-md bg-accent animate-pulse [animation-duration:1.5s]" />
        </section>
      ))}
    </main>
  );
}
