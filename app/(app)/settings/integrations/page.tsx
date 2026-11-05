import { redirect } from "next/navigation";
import { Blocks } from "lucide-react";

import { getDatabase } from "@/db/client";
import { listAgentRecords } from "@/lib/agents/data";
import { validateSession } from "@/lib/auth/session";
import { PageHeader } from "@/components/ui/page-header";
import { listConnectionViews } from "@/lib/connections/service";
import { readComposioKey, listComposioAccountViews } from "@/lib/composio/service";
import { ConnectionsSettings, type AgentOption } from "../connections/connections-settings";
import { ComposioSettings } from "../connections/composio-settings";
import { githubInstallUrl } from "@/lib/connections/slug";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ agent?: string | string[] }> }) {
  const session = await validateSession();
  if (!session) redirect("/login");
  let connections;
  let composioKey;
  let composioAccounts;
  let agents: AgentOption[];
  try {
    const database = await getDatabase();
    const records = await listAgentRecords(database, session.ownerId);
    agents = records.map((agent) => ({
      id: agent.id, name: agent.name, status: agent.status as "active" | "paused",
    }));
    connections = await listConnectionViews(database, session.ownerId);
    composioKey = await readComposioKey(database, session.ownerId);
    composioAccounts = await listComposioAccountViews(database, session.ownerId);
  } catch {
    return (
      <div className="p-6">
        <p role="alert" className="text-sm text-danger">Integrations are temporarily unavailable. Try again from the navigation.</p>
      </div>
    );
  }
  const { agent: agentParam } = await searchParams;
  const requestedAgent = Array.isArray(agentParam) ? agentParam[0] : agentParam;
  const defaultAgentId = requestedAgent && agents.some((agent) => agent.id === requestedAgent) ? requestedAgent : undefined;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10 sm:px-6">
      <PageHeader icon={Blocks} title="Integrations" subtitle="GitHub and Composio API connections. Each token is encrypted on this machine and added only at the egress proxy, for the exact hosts it belongs to. Agents, models, logs and receipts never see it." />
      <section aria-label="GitHub connections">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">GitHub API</h2>
        <ConnectionsSettings initial={connections} agents={agents} csrfToken={session.csrfToken} installUrl={githubInstallUrl()} defaultAgentId={defaultAgentId} />
      </section>
      <section aria-label="Composio API" className="border-t border-border pt-6">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Composio API</h2>
        <ComposioSettings initialKey={composioKey} initialAccounts={composioAccounts} agents={agents} csrfToken={session.csrfToken} defaultAgentId={defaultAgentId} showAccountsSection={false} />
      </section>
    </div>
  );
}
