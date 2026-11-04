import { redirect } from "next/navigation";
import { Plug } from "lucide-react";

import { getDatabase } from "@/db/client";
import { validateSession } from "@/lib/auth/session";
import { loadShellContext } from "@/lib/shell/context";
import { AppShell } from "@/components/workspace/app-shell";
import { PageHeader } from "@/components/ui/page-header";
import { listConnectionViews } from "@/lib/connections/service";
import { listMcpServerViews } from "@/lib/mcp/service";
import { McpSettings, type ConnectionOption } from "./mcp-settings";
import { ComposioSettings } from "./composio-settings";
import { readComposioKey, listComposioAccountViews } from "@/lib/composio/service";
import { ConnectionsSettings, type AgentOption } from "./connections-settings";
import { githubInstallUrl } from "@/lib/connections/slug";

export const dynamic = "force-dynamic";

export default async function ConnectionsPage() {
  const session = await validateSession();
  if (!session) redirect("/login");
  let context: Awaited<ReturnType<typeof loadShellContext>> | null = null;
  let connections;
  let servers;
  let composioKey;
  let composioAccounts;
  let agents: AgentOption[];
  try {
    const database = await getDatabase();
    context = await loadShellContext(database, session.ownerId);
    agents = context.agents.map((agent) => ({
      id: agent.id, name: agent.name, status: agent.status as "active" | "paused",
    }));
    connections = await listConnectionViews(database, session.ownerId);
    servers = await listMcpServerViews(database, session.ownerId);
    composioKey = await readComposioKey(database, session.ownerId);
    composioAccounts = await listComposioAccountViews(database, session.ownerId);
  } catch {
    return (
      <AppShell owner={null} agents={[]} pageTitle="Connections">
        <div className="p-6">
          <p role="alert" className="text-sm text-danger">Connections are temporarily unavailable. Try again from the navigation.</p>
        </div>
      </AppShell>
    );
  }
  const contextAgents = context.agents;
  return (
    <AppShell owner={{ email: context.ownerEmail, timezone: context.ownerTimeZone }} agents={contextAgents} csrfToken={session.csrfToken} pageTitle="Connections">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10 sm:px-6">
        <PageHeader icon={Plug} title="Connections" subtitle="Tokens for tools your agents use. Each token is encrypted on this machine and added only at the egress proxy, for the exact hosts it belongs to. Agents, models, logs and receipts never see it." />
        <ConnectionsSettings initial={connections} agents={agents} csrfToken={session.csrfToken} installUrl={githubInstallUrl()} />
        <section aria-label="MCP servers">
          <McpSettings initial={servers} agents={agents} csrfToken={session.csrfToken}
            connections={connections.map<ConnectionOption>((row) => ({ id: row.id, agentId: row.agentId, label: row.label, preset: row.preset }))} />
        </section>
        <section aria-label="Composio">
          <ComposioSettings initialKey={composioKey} initialAccounts={composioAccounts} agents={agents} csrfToken={session.csrfToken} />
        </section>
      </div>
    </AppShell>
  );
}
