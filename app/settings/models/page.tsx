import { redirect } from "next/navigation";
import { Boxes } from "lucide-react";

import { getDatabase } from "@/db/client";
import { validateSession } from "@/lib/auth/session";
import { loadShellContext } from "@/lib/shell/context";
import { AppShell } from "@/components/workspace/app-shell";
import { PageHeader } from "@/components/ui/page-header";
import { createModelSettingsStore } from "@/lib/models/data";
import { readModelSettings } from "@/lib/models/service";
import { loadPriceRows } from "@/lib/costs/store";
import { ModelSettings } from "./model-settings";
import { PriceTable } from "./price-table";

export const dynamic = "force-dynamic";

export default async function ModelsPage() {
  const session = await validateSession();
  if (!session) redirect("/login");
  let context: Awaited<ReturnType<typeof loadShellContext>> | null = null;
  let settings;
  let prices;
  try {
    const database = await getDatabase();
    context = await loadShellContext(database, session.ownerId);
    const store = createModelSettingsStore(database);
    settings = await readModelSettings(store, session.ownerId);
    prices = await loadPriceRows(database, session.ownerId);
  } catch {
    return (
      <AppShell owner={null} agents={[]} pageTitle="Models">
        <div className="p-6">
          <p role="alert" className="text-sm text-danger">Model settings are temporarily unavailable. Try again from the navigation.</p>
        </div>
      </AppShell>
    );
  }
  const contextAgents = context.agents;
  const ownerChip = { email: context.ownerEmail, timezone: context.ownerTimeZone };
  return (
    <AppShell owner={ownerChip} agents={contextAgents} csrfToken={session.csrfToken} pageTitle="Models">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10 sm:px-6">
        <PageHeader icon={Boxes} title="Models" subtitle="Choose the model Eclipse Crew uses for thinking and optional vision precision. Keys are encrypted on this machine and never sent to a model." />
        <ModelSettings initial={settings} csrfToken={session.csrfToken} />
        <section className="rounded-lg border border-border bg-card p-4" aria-labelledby="price-table-heading">
          <h2 id="price-table-heading" className="text-lg font-semibold tracking-tight">Prices</h2>
          <p className="mb-4 mt-1 text-sm text-muted-foreground">
            Rates used for budgets and cost receipts. Built-in values come from Meta&apos;s published prices.
          </p>
          <PriceTable initial={prices} csrfToken={session.csrfToken} />
        </section>
      </div>
    </AppShell>
  );
}
