import { redirect } from "next/navigation";
import { UsersRound } from "lucide-react";

import { getDatabase } from "@/db/client";
import { listAgentRecords } from "@/lib/agents/data";
import { validateSession } from "@/lib/auth/session";
import { PageHeader } from "@/components/ui/page-header";
import { getStarterCrew } from "@/lib/crew/starter";
import type { StarterCrewView } from "@/lib/crew/schema";
import { StarterCrew } from "@/components/crew/starter-crew";
import { CustomCrews } from "@/components/crew/custom-crews";

export const dynamic = "force-dynamic";

export default async function CrewPage() {
  const session = await validateSession();
  if (!session) redirect("/login");

  let data: {
    crew: StarterCrewView;
    agents: { id: string; name: string; status: "active" | "paused" }[];
  } | null = null;
  let loadError = false;
  try {
    const database = await getDatabase();
    const records = await listAgentRecords(database, session.ownerId);
    const crew = await getStarterCrew(database, session.ownerId);
    data = {
      crew,
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
      <div className="p-6">
        <p role="alert" className="text-sm text-danger">
          {loadError ? "Crew status is temporarily unavailable." : "Crew data could not be loaded."} Try again from the navigation.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6">
      <PageHeader icon={UsersRound} title="Crew" subtitle="The starter crew and your own crews. Live status and run history live on Mission Control. Everything here is owner-only." />
      <StarterCrew initial={data.crew} csrfToken={session.csrfToken} />
      <CustomCrews csrfToken={session.csrfToken} />
    </div>
  );
}
