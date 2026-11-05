import { redirect } from "next/navigation";
import { CalendarClock } from "lucide-react";

import { validateSession } from "@/lib/auth/session";
import { PageHeader } from "@/components/ui/page-header";
import { UpcomingRuns } from "@/components/jobs/upcoming-runs";

export const dynamic = "force-dynamic";

// Schedules: routines and their upcoming runs. Describe-a-task + templates
// land here next; routines themselves are created and confirmed in chat.
export default async function SchedulesPage() {
  const session = await validateSession();
  if (!session) redirect("/login");

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6">
      <PageHeader icon={CalendarClock} title="Schedules" subtitle="Routines and their upcoming runs. Ask an agent in chat to create one, then confirm it there." />
      <UpcomingRuns agent="" csrfToken={session.csrfToken} />
    </div>
  );
}
