import { notFound } from "next/navigation";
import { getDatabase } from "@/db/client";
import { owner } from "@/db/schema";
import { SetupForm } from "./setup-form";

export const dynamic = "force-dynamic";

// First-run setup (reference image 21). The four reference steps exist, but steps 2–4 are
// completed in the app: the timezone is detected here and editable in Account settings, the
// model connects in Settings → Models, and the first agent is created in the workspace.
// The rail states this instead of faking wizard steps.
const STEPS = [
  { n: "01", title: "Owner account", note: "Current step", current: true },
  { n: "02", title: "Timezone", note: "Detected from this machine; editable in Account settings" },
  { n: "03", title: "Model connection", note: "In Settings → Models after setup" },
  { n: "04", title: "First agent", note: "In the workspace after setup" },
];

export default async function SetupPage() {
  const db = await getDatabase();
  const rows = await db.select().from(owner).limit(1);
  if (rows.length > 0) notFound();

  return (
    <main className="flex min-h-screen flex-col bg-background lg:flex-row">
      <aside aria-label="First-run setup" className="flex w-full shrink-0 flex-col justify-between border-b border-border px-6 py-6 lg:h-screen lg:w-[320px] lg:border-b-0 lg:border-r lg:px-8 lg:py-8">
        <div>
          <p className="text-xl font-semibold tracking-tight">Eclipse Crew</p>
          <p className="mt-10 text-xs text-muted-foreground">First-run setup · 4 steps</p>
          <ol className="mt-4 flex flex-col gap-5">
            {STEPS.map((step) => (
              <li key={step.n} className="flex items-start gap-3">
                <span aria-hidden="true" className={`flex size-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${step.current ? "border-border-strong bg-surface-hover text-foreground" : "border-border text-muted-foreground"}`}>
                  {step.n}
                </span>
                <span className="min-w-0">
                  <span className={`block text-sm ${step.current ? "font-semibold text-foreground" : "font-medium text-muted-foreground"}`}>{step.title}</span>
                  <span className="block text-xs text-muted-foreground">{step.note}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
        <p className="mt-10 text-xs text-muted-foreground">
          Self-hosted on your machine. One owner controls this installation. <span className="font-medium text-foreground">Private by default.</span>
        </p>
      </aside>
      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-xl">
          <p className="text-xs text-muted-foreground">Step 1 of 4</p>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-balance">Create your owner account</h1>
          <p className="mt-3 text-sm text-muted-foreground">This account will be the single owner of your Eclipse Crew installation.</p>
          <div className="mt-8 rounded-xl border border-border bg-card p-6">
            <h2 className="text-lg font-semibold tracking-tight">Owner details</h2>
            <SetupForm />
          </div>
          <p className="mt-6 flex items-center justify-end gap-2 text-xs text-muted-foreground">
            Credentials are stored for this installation only
          </p>
        </div>
      </div>
    </main>
  );
}
