import { redirect } from "next/navigation";
import { z } from "zod";
import { getAgentRecord, listAgentRecords } from "@/lib/agents/data";
import { getDatabase } from "@/db/client";
import { validateSession } from "@/lib/auth/session";
import { desktopSession } from "@/lib/desktop/client";
import { ChatPane } from "@/components/chat/chat-pane";
import { requireMaxUploadBytes } from "@/lib/config/server";
import { LiveView } from "@/components/desktop/live-view";
import { createModelSettingsStore } from "@/lib/models/data";
import { AgentPane, type AgentSummary } from "@/components/workspace/agent-pane";
import { AgentSettings } from "@/components/workspace/agent-settings";
import { WorkspacePanel } from "@/components/workspace/workspace-panel";
import { HistoryPanel } from "@/components/history/history-panel";
import { MemoryPanel } from "@/components/memory/memory-panel";
import { owner } from "@/db/schema";
import { resolveTimezone } from "@/lib/time/clock";
import { eq } from "drizzle-orm";
import { WorkspaceShell } from "@/components/workspace/workspace-shell";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ agent?: string | string[] }> }) {
  const session = await validateSession();
  if (!session) redirect("/login");
  const database = await getDatabase();
  // Times in History use the owner's saved zone; a failed read falls back to UTC.
  let ownerTimeZone = "UTC";
  try {
    const rows = await database.select({ timezone: owner.timezone }).from(owner).where(eq(owner.id, session.ownerId)).limit(1);
    ownerTimeZone = resolveTimezone(rows[0]?.timezone) ?? "UTC";
  } catch { ownerTimeZone = "UTC"; }
  const storedAgents = await listAgentRecords(database, session.ownerId);
  const agents: AgentSummary[] = storedAgents.map((agent) => ({
    ...agent, status: agent.status === "active" ? "active" : "paused",
    attention: agent.attentionReason === "budget_warning" || agent.attentionReason === "budget_paused" || agent.attentionReason === "security_stop" || agent.attentionReason === "approval_pending" ? agent.attentionReason : null,
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
  // Shown in the expanded desktop view; a failed read just hides it.
  let modelName: string | undefined;
  if (liveAgentId) {
    try { modelName = (await createModelSettingsStore(database).load(session.ownerId)).main?.model ?? undefined; } catch { modelName = undefined; }
  }
  const mobileInitialView = liveAgentId ? "panel" : error ? "agents" : "chat";
  const chatAgent = selectedAgent
    ? { id: selectedAgent.id, name: selectedAgent.name, status: selectedAgent.status, astraMode: selectedAgent.astraMode }
    : undefined;
  // A bad MAX_UPLOAD_MB must not take the whole workspace down: the upload route reports it instead.
  let maxUploadBytes: number | undefined;
  try { maxUploadBytes = requireMaxUploadBytes(); } catch { maxUploadBytes = undefined; }
  const chatPane = <ChatPane key={chatAgent?.id ?? "no-agent"} agent={chatAgent} csrfToken={session.csrfToken} maxUploadBytes={maxUploadBytes} />;

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
          desktop={liveAgentId ? <LiveView agentId={liveAgentId} agentName={selectedAgent?.name ?? "Agent desktop"} astraMode={selectedAgent?.astraMode} modelName={modelName} /> : undefined}
          history={<HistoryPanel key={selectedAgent?.id ?? "no-agent"} agentId={selectedAgent?.id} agentName={selectedAgent?.name} astraMode={selectedAgent?.astraMode} timeZone={ownerTimeZone} csrfToken={session.csrfToken} />}
          memory={<MemoryPanel key={`memory-${selectedAgent?.id ?? "no-agent"}`} agentId={selectedAgent?.id} timeZone={ownerTimeZone} csrfToken={session.csrfToken} />}
        />
      )}
    />
  );
}
