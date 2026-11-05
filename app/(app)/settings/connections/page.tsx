import { redirect } from "next/navigation";
import { Plug } from "lucide-react";

import { getDatabase } from "@/db/client";
import { listAgentRecords } from "@/lib/agents/data";
import { validateSession } from "@/lib/auth/session";
import { PageHeader } from "@/components/ui/page-header";
import { listConnectionViews } from "@/lib/connections/service";
import { listMcpServerViews } from "@/lib/mcp/service";
import { readComposioKey, listComposioAccountViews } from "@/lib/composio/service";
import { McpSettings, type ConnectionOption } from "./mcp-settings";
import { ComposioSettings } from "./composio-settings";

export const dynamic = "force-dynamic";

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ agent?: string | string[] }> }) {
  const session = await validateSession();
  if (!session) redirect("/login");
  let connections;
  let servers;
  let composioKey;
  let composioAccounts;
  let agents: { id: string; name: string; status: "active" | "paused" }[];
  try {
    const database = await getDatabase();
    const records = await listAgentRecords(database, session.ownerId);
    agents = records.map((agent) => ({
      id: agent.id, name: agent.name, status: agent.status as "active" | "paused",
    }));
    connections = await listConnectionViews(database, session.ownerId);
    servers = await listMcpServerViews(database, session.ownerId);
    composioKey = await readComposioKey(database, session.ownerId);
    composioAccounts = await listComposioAccountViews(database, session.ownerId);
  } catch {
    return (
      <div className="p-6">
        <p role="alert" className="text-sm text-danger">Connectors are temporarily unavailable. Try again from the navigation.</p>
      </div>
    );
  }
  const { agent: agentParam } = await searchParams;
  const requestedAgent = Array.isArray(agentParam) ? agentParam[0] : agentParam;
  const defaultAgentId = requestedAgent && agents.some((agent) => agent.id === requestedAgent) ? requestedAgent : undefined;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10 sm:px-6">
      <PageHeader icon={Plug} title="Connectors" subtitle="Pinned MCP servers and plugin apps your agents may call. GitHub and Composio API keys live under Integrations." />
      <section aria-label="MCP servers">
        <McpSettings initial={servers} agents={agents} csrfToken={session.csrfToken} defaultAgentId={defaultAgentId}
          connections={connections.map<ConnectionOption>((row) => ({ id: row.id, agentId: row.agentId, label: row.label, preset: row.preset }))} />
      </section>
      <section aria-label="Plugins" className="border-t border-border pt-6">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Plugins</h2>
        <ComposioSettings initialKey={composioKey} initialAccounts={composioAccounts} agents={agents} csrfToken={session.csrfToken} defaultAgentId={defaultAgentId} showKeySection={false} />
      </section>
    </div>
  );
}
