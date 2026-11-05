import { getDatabase } from "@/db/client";
import { owner } from "@/db/schema";
import { validateSession } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { getImageProps } from "next/image";
import { Lock, ShieldCheck } from "lucide-react";
import meadow from "./cloudbound-meadow.png";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

const { props: meadowProps } = getImageProps({
  src: meadow,
  alt: "",
  loading: "eager",
  fetchPriority: "high",
  sizes: "(min-width: 768px) 50vw, 100vw",
});
export default async function LoginPage() {
  const db = await getDatabase();
  const rows = await db.select().from(owner).limit(1);
  if (rows.length === 0) redirect("/setup");

  const session = await validateSession();
  if (session) redirect("/");

  return (
    <main className="relative grid h-dvh grid-cols-1 overflow-y-auto bg-background md:grid-cols-2 md:overflow-hidden">
      <p className="absolute left-6 top-8 z-10 text-lg font-semibold tracking-tight text-white [text-shadow:0_1px_8px_rgba(0,0,0,0.55)] md:left-12 md:top-12">Eclipse Crew</p>
      <div aria-hidden="true" className="relative min-h-64 md:min-h-0">
        {/* The strict CSP requires CSS sizing; omit Next's inline image styles. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img {...meadowProps} alt="" style={undefined} className="absolute inset-0 size-full object-cover object-center" />
      </div>
      <section aria-labelledby="sign-in-heading" className="flex flex-col px-6 py-8 md:min-h-0 md:overflow-y-auto md:p-12">
        <div className="flex flex-1 items-center justify-center py-12">
          <div className="w-full max-w-sm">
            <span aria-hidden="true" className="flex size-12 items-center justify-center rounded-full border border-border bg-surface">
              <Lock className="size-5" strokeWidth={1.5} />
            </span>
            <h1 id="sign-in-heading" className="mt-6 text-2xl font-semibold tracking-tight">Sign in</h1>
            <p className="mt-2 text-sm text-muted-foreground">Access your self-hosted crew workspace.</p>
            <LoginForm />
          </div>
        </div>
        <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <ShieldCheck aria-hidden="true" className="size-3.5" />Private access · Self-hosted
        </p>
      </section>
    </main>
  );
}
