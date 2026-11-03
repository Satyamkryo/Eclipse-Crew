import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { ShieldCheck, UsersRound } from "lucide-react";

import { getDatabase } from "@/db/client";
import { owner } from "@/db/schema";
import { listAgentRecords } from "@/lib/agents/data";
import { validateSession } from "@/lib/auth/session";
import { loadShellContext } from "@/lib/shell/context";
import { AppShell } from "@/components/workspace/app-shell";
import { PageHeader } from "@/components/ui/page-header";
import { getStarterCrew } from "@/lib/crew/starter";
import { loadReportSettings } from "@/lib/crew/report";
import { loadCrewStatus, type CrewStatusView } from "@/lib/crew/status";
import { validTimezone } from "@/lib/crew/time";
import type { StarterCrewView } from "@/lib/crew/schema";
import type { ReportSettingsView } from "@/lib/crew/report";
import { MissionControl } from "@/components/crew/mission-control";
import { StarterCrew } from "@/components/crew/starter-crew";
import { ReportSettings } from "@/components/crew/report-settings";

export const dynamic = "force-dynamic";

export default async function CrewPage() {
  const session = await validateSession();
  if (!session) redirect("/login");

  let data: {
    status: CrewStatusView;
    crew: StarterCrewView;
    settings: ReportSettingsView;
    agents: { id: string; name: string; status: "active" | "paused" }[];
  } | null = null;
  let loadError = false;
  try {
    const database = await getDatabase();
    const ownerRows = await database.select({ timezone: owner.timezone }).from(owner).where(eq(owner.id, session.ownerId)).limit(1);
    const timezone = validTimezone(ownerRows[0]?.timezone) ?? "UTC";
    const records = await listAgentRecords(database, session.ownerId);
    const [status, crew, settings] = await Promise.all([
      loadCrewStatus(database, session.ownerId, timezone),
      getStarterCrew(database, session.ownerId),
      loadReportSettings(database, session.ownerId),
    ]);
    data = {
      status,
      crew,
      settings,
      agents: records.map((record) => ({
        id: record.id,
        name: record.name,
        status: record.status === "active" ? "active" : "paused",
      })),
    };
  } catch {
    loadError = true;
  }

  if (!data) {
    return (
      <AppShell owner={null} agents={[]} pageTitle="Crew">
        <div className="p-6">
          <p role="alert" className="text-sm text-danger">
            {loadError ? "Crew status is temporarily unavailable." : "Crew data could not be loaded."} Try again from the navigation.
          </p>
        </div>
      </AppShell>
    );
  }

  const shellContext = await loadShellContextSafe(session.ownerId);
  return (
    <AppShell owner={shellContext ? { email: shellContext.ownerEmail, timezone: shellContext.ownerTimeZone } : null} agents={shellContext?.agents ?? []} csrfToken={session.csrfToken} pageTitle="Crew">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6">
        <PageHeader icon={UsersRound} title="Crew" subtitle="Mission Control, the starter crew and the morning report. Everything here is owner-only."
          action={(
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <Link href="/jobs" className="underline underline-offset-4">Jobs</Link>
              <Link href="/settings/connections" className="underline underline-offset-4">Connections</Link>
              <Link href="/security" className="inline-flex items-center gap-1 underline underline-offset-4">
                <ShieldCheck aria-hidden="true" className="size-4" />Security
              </Link>
            </div>
          )} />
        <MissionControl initial={data.status} />
        <StarterCrew initial={data.crew} csrfToken={session.csrfToken} />
        <ReportSettings agents={data.agents} initial={data.settings} csrfToken={session.csrfToken} />
      </div>
    </AppShell>
  );
}

// The crew page renders even when the shell data fails; a failed shell load just hides the chip.
async function loadShellContextSafe(ownerId: string) {
  try { return await loadShellContext(await getDatabase(), ownerId); } catch { return null; }
}
