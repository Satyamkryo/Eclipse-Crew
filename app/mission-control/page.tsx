import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { Activity } from "lucide-react";

import { getDatabase } from "@/db/client";
import { owner } from "@/db/schema";
import { listAgentRecords } from "@/lib/agents/data";
import { validateSession } from "@/lib/auth/session";
import { loadShellContext } from "@/lib/shell/context";
import { AppShell } from "@/components/workspace/app-shell";
import { PageHeader } from "@/components/ui/page-header";
import { loadCrewStatus, type CrewStatusView } from "@/lib/crew/status";
import { validTimezone } from "@/lib/crew/time";
import { MissionControl } from "@/components/crew/mission-control";
import { JobsDashboard } from "@/components/jobs/jobs-dashboard";

export const dynamic = "force-dynamic";

// Mission Control: live agent frames on top, run history ("Runs") below.
// Everything here is owner-only. /jobs redirects here; run detail pages stay put.
export default async function MissionControlPage({ searchParams }: { searchParams: Promise<{ range?: string | string[] }> }) {
  const session = await validateSession();
  if (!session) redirect("/login");

  const { range } = await searchParams;
  const initialRange = Array.isArray(range) ? range[0] : range;

  let status: CrewStatusView | null = null;
  let timezone = "UTC";
  let agents: { id: string; name: string }[] = [];
  try {
    const database = await getDatabase();
    const ownerRows = await database.select({ timezone: owner.timezone }).from(owner).where(eq(owner.id, session.ownerId)).limit(1);
    timezone = validTimezone(ownerRows[0]?.timezone) ?? "UTC";
    const [loaded, records] = await Promise.all([
      loadCrewStatus(database, session.ownerId, timezone),
      listAgentRecords(database, session.ownerId),
    ]);
    status = loaded;
    agents = records.map((record) => ({ id: record.id, name: record.name }));
  } catch {
    status = null;
  }

  let shellContext: Awaited<ReturnType<typeof loadShellContext>> | null = null;
  try { shellContext = await loadShellContext(await getDatabase(), session.ownerId); } catch { shellContext = null; }

  return (
    <AppShell owner={shellContext ? { email: shellContext.ownerEmail, timezone: shellContext.ownerTimeZone } : null} agents={shellContext?.agents ?? []} csrfToken={session.csrfToken} pageTitle="Mission Control">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-6 sm:px-6">
        <PageHeader icon={Activity} title="Mission Control" subtitle="Live status, current step and spend for this owner only. Everything here is owner-only." />
        <MissionControl initial={status} />
        <section aria-labelledby="runs-heading">
          <h2 id="runs-heading" className="text-lg font-semibold tracking-tight">Runs</h2>
          <p className="mt-1 text-sm text-muted-foreground">Tracker of what your agents already ran — what succeeded and what failed.</p>
          <div className="mt-4">
            <JobsDashboard agents={agents} csrfToken={session.csrfToken} timeZone={timezone} bare initialRange={initialRange} />
          </div>
        </section>
      </div>
    </AppShell>
  );
}
