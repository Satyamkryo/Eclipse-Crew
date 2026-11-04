import "server-only";

import { desktopSession, type DesktopStatus, type SessionOperation } from "../desktop/client";

// An agent's sandbox, graphical desktop and managed browser are independent. A run may use tools, shell and files
// with no display; visual work acquires the desktop through this bounded, idempotent path.
export interface AgentLifecycle {
  generation(): string | null;
  status(): Promise<DesktopStatus>;
  ensureSandbox(): Promise<DesktopStatus>;
  ensureDesktop(): Promise<DesktopStatus>;
  ensureBrowser(): Promise<DesktopStatus>;
  stopDesktop(): Promise<DesktopStatus>;
  stopBrowser(): Promise<DesktopStatus>;
}

export class DesktopLifecycleError extends Error {
  constructor(public code: string) { super(code); this.name = "DesktopLifecycleError"; }
}

const codeOf = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : "desktop_unavailable";
};

export function createAgentLifecycle(agentId: string, ownerId: string, authorizeStart?: () => Promise<void>): AgentLifecycle {
  let current: string | null = null;
  const authorize = async () => { if (authorizeStart) await authorizeStart(); };
  async function call(operation: SessionOperation): Promise<DesktopStatus> {
    try {
      const status = await desktopSession(agentId, ownerId, operation, current ?? undefined);
      if (status.generation) current = status.generation;
      return status;
    } catch (error) {
      throw new DesktopLifecycleError(codeOf(error));
    }
  }
  const requireSandbox = (status: DesktopStatus) => {
    if (status.state !== "running" || !status.generation) throw new DesktopLifecycleError("sandbox_start_failed");
    return status;
  };
  const requireDesktop = (status: DesktopStatus) => {
    requireSandbox(status);
    if (status.graphics !== "running") throw new DesktopLifecycleError("desktop_start_failed");
    if (status.browser !== "running") throw new DesktopLifecycleError("browser_start_failed");
    return status;
  };
  return {
    generation: () => current,
    status: () => call("session.status"),
    ensureSandbox: async () => { await authorize(); return requireSandbox(await call("sandbox.start")); },
    ensureDesktop: async () => { await authorize(); return requireDesktop(await call("desktop.start")); },
    ensureBrowser: async () => {
      await authorize();
      const status = await call("browser.start");
      requireSandbox(status);
      if (status.graphics !== "running") throw new DesktopLifecycleError("desktop_start_failed");
      if (status.browser !== "running") throw new DesktopLifecycleError("browser_start_failed");
      return status;
    },
    stopDesktop: () => call("desktop.stop"),
    stopBrowser: () => call("browser.stop"),
  };
}
