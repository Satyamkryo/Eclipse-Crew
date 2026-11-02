import Link from "next/link";
import { redirect } from "next/navigation";

import { getDatabase } from "@/db/client";
import { listAgentRecords } from "@/lib/agents/data";
import { validateSession } from "@/lib/auth/session";
import { listConnectionViews } from "@/lib/connections/service";
import { listMcpServerViews } from "@/lib/mcp/service";
import { McpSettings, type ConnectionOption } from "./mcp-settings";
import { ComposioSettings } from "./composio-settings";
import { readComposioKey, listComposioAccountViews } from "@/lib/composio/service";
import { ConnectionsSettings, type AgentOption } from "./connections-settings";

export const dynamic = "force-dynamic";

export default async function ConnectionsPage() {
  const session = await validateSession();
  if (!session) redirect("/login");
  let connections;
  let servers;
  let composioKey;
  let composioAccounts;
  let agents: AgentOption[];
  try {
    const database = await getDatabase();
    agents = (await listAgentRecords(database, session.ownerId)).map((agent) => ({
      id: agent.id, name: agent.name, status: agent.status as "active" | "paused",
    }));
    connections = await listConnectionViews(database, session.ownerId);
    servers = await listMcpServerViews(database, session.ownerId);
    composioKey = await readComposioKey(database, session.ownerId);
    composioAccounts = await listComposioAccountViews(database, session.ownerId);
  } catch {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-4 py-10 sm:px-6 sm:py-16">
        <Link href="/" className="text-sm underline underline-offset-4">Back to workspace</Link>
        <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
        <p role="alert" className="text-sm text-danger">
          Connections are temporarily unavailable. <Link href="/settings/connections" className="underline underline-offset-4">Try again</Link>.
        </p>
      </main>
    );
  }
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-4 py-10 sm:px-6 sm:py-16">
      <Link href="/" className="text-sm underline underline-offset-4">Back to workspace</Link>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
        <p className="mt-2 max-w-[70ch] text-sm text-muted-foreground">
          Tokens for tools your agents use. Each token is encrypted on this machine and added only at the egress proxy,
          for the exact hosts it belongs to. Agents, models, logs and receipts never see it.
        </p>
      </header>
      <ConnectionsSettings initial={connections} agents={agents} csrfToken={session.csrfToken} />
      <section aria-label="MCP servers">
        <McpSettings initial={servers} agents={agents} csrfToken={session.csrfToken}
          connections={connections.map<ConnectionOption>((row) => ({ id: row.id, agentId: row.agentId, label: row.label, preset: row.preset }))} />
      </section>
      <section aria-label="Composio">
        <ComposioSettings initialKey={composioKey} initialAccounts={composioAccounts} agents={agents} csrfToken={session.csrfToken} />
      </section>
    </main>
  );
}
