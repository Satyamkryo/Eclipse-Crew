import { redirect } from "next/navigation";
import { UserRound } from "lucide-react";
import { getDatabase } from "@/db/client";
import { getAccountOverview } from "@/lib/auth/account";
import { validateSession } from "@/lib/auth/session";
import { loadShellContext } from "@/lib/shell/context";
import { AppShell } from "@/components/workspace/app-shell";
import { PageHeader } from "@/components/ui/page-header";
import { AccountSettings } from "@/app/settings/account/account-settings";

export const dynamic = "force-dynamic";

// Owner profile: email, password and sessions. Opened by clicking the
// profile chip in the header.
export default async function ProfilePage() {
  const session = await validateSession();
  if (!session) redirect("/login");
  let context: Awaited<ReturnType<typeof loadShellContext>> | null = null;
  let overview;
  try {
    const database = await getDatabase();
    context = await loadShellContext(database, session.ownerId);
    overview = await getAccountOverview(database, session.ownerId, session.sessionId);
  } catch {
    return (
      <AppShell owner={null} agents={[]} pageTitle="Profile">
        <div className="p-6">
          <p role="alert" className="text-sm text-danger">Profile settings are temporarily unavailable. Try again from the navigation.</p>
        </div>
      </AppShell>
    );
  }
  const format = new Intl.DateTimeFormat("en", { timeZone: overview.timezone, dateStyle: "medium", timeStyle: "short" });
  const sessions = overview.sessions.map(({ id, createdAt, expiresAt, current }) => ({
    id, created: format.format(createdAt), expires: format.format(expiresAt), current,
  }));
  const contextAgents = context.agents;
  return (
    <AppShell owner={{ email: context.ownerEmail, timezone: context.ownerTimeZone }} agents={contextAgents} csrfToken={session.csrfToken} pageTitle="Profile">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10">
        <PageHeader icon={UserRound} title="Profile" subtitle={`Signed in as ${overview.login}. Times use ${overview.timezone}.`} />
        <AccountSettings login={overview.login} timezone={overview.timezone} sessions={sessions} csrfToken={session.csrfToken} />
      </div>
    </AppShell>
  );
}
