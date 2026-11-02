import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDatabase } from "@/db/client";
import { owner } from "@/db/schema";
import { validateSession } from "@/lib/auth/session";
import { resolveTimezone } from "@/lib/time/clock";
import { JobDetail } from "@/components/jobs/job-detail";

export const dynamic = "force-dynamic";

export default async function JobDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const session = await validateSession();
  if (!session) redirect("/login");
  const parsed = z.string().uuid().safeParse((await params).runId);
  if (!parsed.success) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-4 px-4 py-10 sm:px-6">
        <Link href="/jobs" className="text-sm underline underline-offset-4">All jobs</Link>
        <p role="alert" className="text-sm text-danger">This run is no longer available.</p>
      </main>
    );
  }
  let timeZone = "UTC";
  try {
    const rows = await (await getDatabase()).select({ timezone: owner.timezone }).from(owner).where(eq(owner.id, session.ownerId)).limit(1);
    timeZone = resolveTimezone(rows[0]?.timezone) ?? "UTC";
  } catch { /* the detail request reports its own error */ }
  return <JobDetail runId={parsed.data} timeZone={timeZone} csrfToken={session.csrfToken} />;
}
