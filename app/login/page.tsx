import { getDatabase } from "@/db/client";
import { owner } from "@/db/schema";
import { validateSession } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { Lock, ShieldCheck } from "lucide-react";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const db = await getDatabase();
  const rows = await db.select().from(owner).limit(1);
  if (rows.length === 0) redirect("/setup");

  const session = await validateSession();
  if (session) redirect("/");

  return (
    <main className="flex min-h-screen flex-col bg-background px-6 py-16">
      <p className="text-xl font-semibold tracking-tight">Eclipse Crew</p>
      <div className="flex flex-1 items-center justify-center">
        <div className="w-full max-w-md rounded-xl border border-border bg-card p-8">
          <span aria-hidden="true" className="flex size-12 items-center justify-center rounded-full border border-border bg-surface">
            <Lock className="size-5" strokeWidth={1.5} />
          </span>
          <h1 className="mt-5 text-2xl font-semibold tracking-tight">Sign in</h1>
          <p className="mt-2 text-sm text-muted-foreground">Access your self-hosted crew workspace.</p>
          <LoginForm />
        </div>
      </div>
      <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
        <ShieldCheck aria-hidden="true" className="size-3.5" />Owner-only access · Local installation
      </p>
    </main>
  );
}
