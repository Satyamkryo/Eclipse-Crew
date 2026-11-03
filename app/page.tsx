import { redirect } from "next/navigation";
import { z } from "zod";
import { getAgentRecord, listAgentRecords } from "@/lib/agents/data";
import { getDatabase } from "@/db/client";
import { validateSession } from "@/lib/auth/session";
import { desktopSession, type DesktopStatus } from "@/lib/desktop/client";
import { DesktopLifecycle } from "@/components/workspace/desktop-lifecycle";
import { ChatPane } from "@/components/chat/chat-pane";
import { requireMaxUploadBytes } from "@/lib/config/server";
import { LiveView } from "@/components/desktop/live-view";
import { createModelSettingsStore } from "@/lib/models/data";
import { AgentPane, type AgentSummary } from "@/components/workspace/agent-pane";
import { AgentSettings } from "@/components/workspace/agent-settings";
import { HistoryPanel } from "@/components/history/history-panel";
import { MemoryPanel } from "@/components/memory/memory-panel";
import { owner } from "@/db/schema";
import { resolveTimezone } from "@/lib/time/clock";
import { eq } from "drizzle-orm";
import { WorkspaceShell } from "@/components/workspace/workspace-shell";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{
  agent?: string | string[]; panel?: string | string[]; run?: string | string[]; continue?: string | string[];
}> }) {
  const session = await validateSession();
  if (!session) redirect("/login");
  const database = await getDatabase();
  // Times in History use the owner's saved zone; a failed read falls back to UTC.
  let ownerTimeZone = "UTC";
  let ownerEmail = "Owner";
  try {
    const rows = await database.select({ timezone: owner.timezone, email: owner.login }).from(owner).where(eq(owner.id, session.ownerId)).limit(1);
    ownerTimeZone = resolveTimezone(rows[0]?.timezone) ?? "UTC";
    ownerEmail = rows[0]?.email ?? "Owner";
  } catch { ownerTimeZone = "UTC"; }
  const storedAgents = await listAgentRecords(database, session.ownerId);
  const agents: AgentSummary[] = storedAgents.map((agent) => ({
    ...agent, status: agent.status === "active" ? "active" : "paused",
    attention: agent.attentionReason === "budget_warning" || agent.attentionReason === "budget_paused" || agent.attentionReason === "security_stop" || agent.attentionReason === "approval_pending" ? agent.attentionReason : null,
  }));
  const { agent, panel, run, continue: continueFlag } = await searchParams;
  const selected = z.string().uuid().safeParse(agent);
  // TASK-085. Continue deep-links into History with the rewind dialog ready at the last saved checkpoint.
  const panelTab = z.enum(["desktop", "settings", "tools", "routines", "history", "memory"]).safeParse(panel);
  const initialRun = z.string().uuid().safeParse(run);
  const initialContinue = continueFlag === "1";
  let selectedAgent: Awaited<ReturnType<typeof getAgentRecord>>;
  let liveAgentId: string | undefined;
  let desktopStatus: DesktopStatus | undefined;
  let error: string | undefined;
  if (agent !== undefined) {
    if (!selected.success) error = "This agent link is invalid.";
    else {
      selectedAgent = await getAgentRecord(database, session.ownerId, selected.data);
      if (!selectedAgent) error = "This agent is unavailable or does not belong to your account.";
      else if (selectedAgent.status === "active") {
        // A stopped desktop is an ordinary state, not a workspace error: chat, tools and settings stay usable.
        try { desktopStatus = await desktopSession(selected.data, session.ownerId, "session.status"); }
        catch { desktopStatus = { agentId: selected.data, state: "stopped", sandbox: "stopped", graphics: "stopped", browser: "stopped" }; }
      } else {
        desktopStatus = { agentId: selected.data, state: "stopped", sandbox: "stopped", graphics: "stopped", browser: "stopped" };
      }
    }
  }
  const graphicsRunning = Boolean(selectedAgent && selectedAgent.status === "active" && desktopStatus?.state === "running" && desktopStatus.graphics === "running");
  if (selectedAgent && graphicsRunning) liveAgentId = selectedAgent.id;
  // Shown in the expanded desktop view; a failed read just hides it.
  let modelName: string | undefined;
  if (liveAgentId) {
    try { modelName = (await createModelSettingsStore(database).load(session.ownerId)).main?.model ?? undefined; } catch { modelName = undefined; }
  }
  const mobileInitialView = error ? "agents" : selectedAgent ? "panel" : "chat";
  const chatAgent = selectedAgent
    ? { id: selectedAgent.id, name: selectedAgent.name, role: selectedAgent.role, status: selectedAgent.status, astraMode: selectedAgent.astraMode }
    : undefined;
  // A bad MAX_UPLOAD_MB must not take the whole workspace down: the upload route reports it instead.
  let maxUploadBytes: number | undefined;
  try { maxUploadBytes = requireMaxUploadBytes(); } catch { maxUploadBytes = undefined; }
  const chatPane = <ChatPane key={chatAgent?.id ?? "no-agent"} agent={chatAgent} csrfToken={session.csrfToken} maxUploadBytes={maxUploadBytes} />;

  // Central tabs superseded the old right-panel tabs; the legacy ?panel= links map onto them.
  const initialTab = panelTab.success && panelTab.data !== "desktop"
    ? panelTab.data
    : initialRun.success ? "history" : undefined;

  return (
    <WorkspaceShell
      key={`${mobileInitialView}:${selectedAgent?.id ?? ""}`}
      initialMobileView={mobileInitialView}
      initialTab={initialTab}
      agents={agents}
      selectedAgent={chatAgent ?? null}
      owner={{ email: ownerEmail, timezone: ownerTimeZone }}
      csrfToken={session.csrfToken}
      agentPane={<AgentPane variant="sidebar" agents={agents} selectedAgentId={selectedAgent?.id} error={error} csrfToken={session.csrfToken} />}
      chatPane={chatPane}
      settings={selectedAgent ? <AgentSettings agent={selectedAgent} desktopStatus={desktopStatus} csrfToken={session.csrfToken} /> : undefined}
      desktop={selectedAgent && selectedAgent.status === "active" ? (
        <div className="flex flex-col gap-3">
          <DesktopLifecycle agentId={selectedAgent.id} csrfToken={session.csrfToken} initial={desktopStatus} />
          {liveAgentId ? <LiveView agentId={liveAgentId} agentName={selectedAgent.name} astraMode={selectedAgent.astraMode} modelName={modelName} /> : null}
        </div>
      ) : undefined}
      history={<HistoryPanel key={`${selectedAgent?.id ?? "no-agent"}:${initialRun.success ? initialRun.data : ""}`} agentId={selectedAgent?.id} agentName={selectedAgent?.name} astraMode={selectedAgent?.astraMode} timeZone={ownerTimeZone} csrfToken={session.csrfToken}
        initialRunId={initialRun.success ? initialRun.data : undefined} initialContinue={initialContinue} />}
      memory={<MemoryPanel key={`memory-${selectedAgent?.id ?? "no-agent"}`} agentId={selectedAgent?.id} timeZone={ownerTimeZone} csrfToken={session.csrfToken} />}
    />
  );
}
