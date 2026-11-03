import { redirect } from "next/navigation";

import { getDatabase } from "@/db/client";
import { validateSession } from "@/lib/auth/session";
import { loadShellContext } from "@/lib/shell/context";
import { AppShell } from "@/components/workspace/app-shell";
import { SecurityCenter } from "@/components/security/security-center";

export const dynamic = "force-dynamic";

export default async function SecurityPage() {
  const session = await validateSession();
  if (!session) redirect("/login");
  let context: Awaited<ReturnType<typeof loadShellContext>> | null = null;
  let timeZone: string;
  let agents: { id: string; name: string }[] = [];
  try {
    const database = await getDatabase();
    context = await loadShellContext(database, session.ownerId);
    timeZone = context.ownerTimeZone;
    agents = context.agents.map((agent) => ({ id: agent.id, name: agent.name }));
  } catch {
    return (
      <AppShell owner={null} agents={[]} pageTitle="Security Center">
        <div className="p-6">
          <p role="alert" className="text-sm text-danger">The Security Center is temporarily unavailable. Try again from the navigation.</p>
        </div>
      </AppShell>
    );
  }
  return (
    <AppShell owner={{ email: context.ownerEmail, timezone: context.ownerTimeZone }} agents={context.agents} csrfToken={session.csrfToken} pageTitle="Security Center">
      <SecurityCenter agents={agents} csrfToken={session.csrfToken} timeZone={timeZone} />
    </AppShell>
  );
}
