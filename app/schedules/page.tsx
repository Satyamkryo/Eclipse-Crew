import { redirect } from "next/navigation";
import { CalendarClock } from "lucide-react";

import { getDatabase } from "@/db/client";
import { validateSession } from "@/lib/auth/session";
import { loadShellContext } from "@/lib/shell/context";
import { AppShell } from "@/components/workspace/app-shell";
import { PageHeader } from "@/components/ui/page-header";
import { UpcomingRuns } from "@/components/jobs/upcoming-runs";

export const dynamic = "force-dynamic";

// Schedules: routines and their upcoming runs. Describe-a-task + templates
// land here next; routines themselves are created and confirmed in chat.
export default async function SchedulesPage() {
  const session = await validateSession();
  if (!session) redirect("/login");

  let shellContext: Awaited<ReturnType<typeof loadShellContext>> | null = null;
  try { shellContext = await loadShellContext(await getDatabase(), session.ownerId); } catch { shellContext = null; }

  return (
    <AppShell owner={shellContext ? { email: shellContext.ownerEmail, timezone: shellContext.ownerTimeZone } : null} agents={shellContext?.agents ?? []} csrfToken={session.csrfToken} pageTitle="Schedules">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6">
        <PageHeader icon={CalendarClock} title="Schedules" subtitle="Routines and their upcoming runs. Ask an agent in chat to create one, then confirm it there." />
        <UpcomingRuns agent="" csrfToken={session.csrfToken} />
      </div>
    </AppShell>
  );
}
