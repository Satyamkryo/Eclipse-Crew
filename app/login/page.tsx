import { getDatabase } from "@/db/client";
import { owner } from "@/db/schema";
import { validateSession } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const db = await getDatabase();
  const rows = await db.select().from(owner).limit(1);
  if (rows.length === 0) redirect("/setup");

  const session = await validateSession();
  if (session) redirect("/");

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-16">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-2 text-sm text-muted-foreground">Enter your Eclipse Crew email and password.</p>
        <LoginForm />
      </div>
    </main>
  );
}
