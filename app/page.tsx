import { redirect } from "next/navigation";
import { z } from "zod";
import { getAgentRecord, listAgentRecords } from "@/lib/agents/data";
import { getDatabase } from "@/db/client";
import { validateSession } from "@/lib/auth/session";
import { desktopSession } from "@/lib/desktop/client";
import { ChatPane } from "@/components/chat/chat-pane";
import { LiveView } from "@/components/desktop/live-view";
import { AgentPane, type AgentSummary } from "@/components/workspace/agent-pane";
import { AgentSettings } from "@/components/workspace/agent-settings";
import { WorkspacePanel } from "@/components/workspace/workspace-panel";
import { WorkspaceShell } from "@/components/workspace/workspace-shell";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ agent?: string | string[] }> }) {
  const session = await validateSession();
  if (!session) redirect("/login");
  const database = await getDatabase();
  const storedAgents = await listAgentRecords(database, session.ownerId);
  const agents: AgentSummary[] = storedAgents.map((agent) => ({
    ...agent, status: agent.status === "active" ? "active" : "paused",
  }));
  const { agent } = await searchParams;
  const selected = z.string().uuid().safeParse(agent);
  let selectedAgent: Awaited<ReturnType<typeof getAgentRecord>>;
  let liveAgentId: string | undefined;
  let desktopRunning = false;
  let error: string | undefined;
  if (agent !== undefined) {
    if (!selected.success) error = "This agent link is invalid.";
    else {
      selectedAgent = await getAgentRecord(database, session.ownerId, selected.data);
      if (!selectedAgent) error = "This agent is unavailable or does not belong to your account.";
      else if (selectedAgent.status === "paused") error = "This agent is paused. Resume it to open the desktop.";
      else {
        try {
          const status = await desktopSession(selected.data, session.ownerId, "session.status");
          desktopRunning = status.state === "running" && Boolean(status.generation);
          if (desktopRunning) liveAgentId = selected.data;
          else error = "This agent desktop is stopped. Start it from Settings.";
        } catch { error = "This agent desktop is unavailable."; }
      }
    }
  }
  const mobileInitialView = liveAgentId ? "panel" : error ? "agents" : "chat";
  const chatAgent = selectedAgent
    ? { id: selectedAgent.id, name: selectedAgent.name, status: selectedAgent.status }
    : undefined;
  const chatPane = <ChatPane key={chatAgent?.id ?? "no-agent"} agent={chatAgent} csrfToken={session.csrfToken} />;

  return (
    <WorkspaceShell
      key={`${mobileInitialView}:${selectedAgent?.id ?? ""}`}
      initialMobileView={mobileInitialView}
      showAgentPanel={Boolean(liveAgentId)}
      showAgentError={Boolean(error)}
      agentPane={<AgentPane agents={agents} selectedAgentId={selectedAgent?.id} error={error} csrfToken={session.csrfToken} />}
      chatPane={chatPane}
      panel={(
        <WorkspacePanel
          settings={selectedAgent ? <AgentSettings agent={selectedAgent} desktopRunning={desktopRunning} csrfToken={session.csrfToken} /> : undefined}
          desktop={liveAgentId ? <LiveView agentId={liveAgentId} agentName={selectedAgent?.name ?? "Agent desktop"} /> : undefined}
        />
      )}
    />
  );
}
