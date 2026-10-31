import { notFound } from "next/navigation";
import { getDatabase } from "@/db/client";
import { owner } from "@/db/schema";
import { SetupForm } from "./setup-form";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const db = await getDatabase();
  const rows = await db.select().from(owner).limit(1);
  if (rows.length > 0) notFound();

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-16">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Create your owner account</h1>
        <p className="mt-2 text-sm text-muted-foreground">This is the only account. Choose a login email and a strong password.</p>
        <SetupForm />
      </div>
    </main>
  );
}
