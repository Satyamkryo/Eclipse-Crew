import { redirect } from "next/navigation";
import { UserRound } from "lucide-react";
import { getDatabase } from "@/db/client";
import { getAccountOverview } from "@/lib/auth/account";
import { validateSession } from "@/lib/auth/session";
import { PageHeader } from "@/components/ui/page-header";
import { BoldPopAvatar } from "@/components/workspace/agent-avatar";
import { AccountSettings } from "@/app/(app)/settings/account/account-settings";

export const dynamic = "force-dynamic";

// Owner profile: email, password and sessions. Opened by clicking the
// profile chip in the header.
export default async function ProfilePage() {
  const session = await validateSession();
  if (!session) redirect("/login");
  let overview;
  try {
    const database = await getDatabase();
    overview = await getAccountOverview(database, session.ownerId, session.sessionId);
  } catch {
    return (
      <div className="p-6">
        <p role="alert" className="text-sm text-danger">Profile settings are temporarily unavailable. Try again from the navigation.</p>
      </div>
    );
  }
  const format = new Intl.DateTimeFormat("en", { timeZone: overview.timezone, dateStyle: "medium", timeStyle: "short" });
  const sessions = overview.sessions.map(({ id, createdAt, expiresAt, current }) => ({
    id, created: format.format(createdAt), expires: format.format(expiresAt), current,
  }));
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10">
      <PageHeader icon={UserRound} avatar={<BoldPopAvatar seed={overview.login} size={44} />} title="Profile" subtitle={`Signed in as ${overview.login}. Times use ${overview.timezone}.`} />
      <AccountSettings login={overview.login} timezone={overview.timezone} sessions={sessions} csrfToken={session.csrfToken} />
    </div>
  );
}
