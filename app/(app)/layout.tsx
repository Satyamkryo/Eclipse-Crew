import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { getDatabase } from "@/db/client";
import { validateSession } from "@/lib/auth/session";
import { loadShellContext } from "@/lib/shell/context";
import { ShellChrome } from "@/components/workspace/shell-chrome";

export const dynamic = "force-dynamic";

// Shared layout for every standalone page (Crew, Mission Control, Schedules,
// Security, Profile, Settings, run detail). The sidebar + top bar mount once
// here; navigating swaps only the main area (children) instead of remounting
// the whole shell per page. The workspace (app/page.tsx) keeps its own
// WorkspaceShell; /login and /setup stay outside this group with no shell.
export default async function AppGroupLayout({ children }: { children: ReactNode }) {
  const session = await validateSession();
  if (!session) redirect("/login");

  let owner: { email: string; timezone: string } | null = null;
  let agents: Awaited<ReturnType<typeof loadShellContext>>["agents"] = [];
  try {
    const context = await loadShellContext(await getDatabase(), session.ownerId);
    owner = { email: context.ownerEmail, timezone: context.ownerTimeZone };
    agents = context.agents;
  } catch {
    owner = null;
    agents = [];
  }

  return (
    <ShellChrome owner={owner} agents={agents} csrfToken={session.csrfToken}>
      {children}
    </ShellChrome>
  );
}
