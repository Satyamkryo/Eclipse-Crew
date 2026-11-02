import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { getDatabase } from "@/db/client";
import { owner } from "@/db/schema";
import { listAgentRecords } from "@/lib/agents/data";
import { validateSession } from "@/lib/auth/session";
import { resolveTimezone } from "@/lib/time/clock";
import { JobsDashboard } from "@/components/jobs/jobs-dashboard";

export const dynamic = "force-dynamic";

export default async function JobsPage() {
  const session = await validateSession();
  if (!session) redirect("/login");
  let data: { agents: { id: string; name: string }[]; timeZone: string } | null = null;
  try {
    const database = await getDatabase();
    const rows = await database.select({ timezone: owner.timezone }).from(owner).where(eq(owner.id, session.ownerId)).limit(1);
    const timeZone = resolveTimezone(rows[0]?.timezone) ?? "UTC";
    const agents = (await listAgentRecords(database, session.ownerId)).map((agent) => ({ id: agent.id, name: agent.name }));
    data = { agents, timeZone };
  } catch { data = null; }
  if (!data) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-4 px-4 py-10 sm:px-6">
        <Link href="/" className="text-sm underline underline-offset-4">Back to workspace</Link>
        <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
        <p role="alert" className="text-sm text-danger">
          Jobs are temporarily unavailable. <Link href="/jobs" className="underline underline-offset-4">Try again</Link>.
        </p>
      </main>
    );
  }
  return <JobsDashboard agents={data.agents} csrfToken={session.csrfToken} timeZone={data.timeZone} />;
}
