import Link from "next/link";
import { redirect } from "next/navigation";
import { getDatabase } from "@/db/client";
import { getAccountOverview } from "@/lib/auth/account";
import { validateSession } from "@/lib/auth/session";
import { AccountSettings } from "./account-settings";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const session = await validateSession();
  if (!session) redirect("/login");
  let overview;
  try {
    overview = await getAccountOverview(await getDatabase(), session.ownerId, session.sessionId);
  } catch {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-16">
        <Link href="/" className="text-sm underline underline-offset-4">Back to workspace</Link>
        <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
        <p role="alert" className="text-sm text-danger">Account settings are temporarily unavailable. <Link href="/settings/account" className="underline underline-offset-4">Try again</Link>.</p>
      </main>
    );
  }
  const format = new Intl.DateTimeFormat("en", { timeZone: overview.timezone, dateStyle: "medium", timeStyle: "short" });
  const sessions = overview.sessions.map(({ id, createdAt, expiresAt, current }) => ({
    id, created: format.format(createdAt), expires: format.format(expiresAt), current,
  }));
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-16">
      <Link href="/" className="text-sm underline underline-offset-4">Back to workspace</Link>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
        <p className="mt-2 text-sm text-muted-foreground">Signed in as {overview.login}. Times use {overview.timezone}.</p>
      </header>
      <AccountSettings login={overview.login} sessions={sessions} csrfToken={session.csrfToken} />
    </main>
  );
}
