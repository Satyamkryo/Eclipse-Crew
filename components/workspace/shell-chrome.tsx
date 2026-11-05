"use client";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell, type OwnerChip } from "@/components/workspace/app-shell";
import type { AgentSummary } from "@/components/workspace/agent-pane";

function titleForPath(pathname: string): string {
  if (pathname === "/crew") return "Crew";
  if (pathname === "/mission-control" || pathname.startsWith("/jobs")) return "Mission Control";
  if (pathname === "/schedules") return "Schedules";
  if (pathname === "/security") return "Security Center";
  if (pathname === "/profile") return "Profile";
  if (pathname.startsWith("/settings/models")) return "Models";
  if (pathname.startsWith("/settings/connections")) return "Connectors";
  if (pathname.startsWith("/settings/integrations")) return "Integrations";
  return "Eclipse Crew";
}

// Persistent shell chrome for every standalone page. Mounted once in
// app/(app)/layout.tsx so the sidebar + top bar stay mounted while only the
// main area (children) swaps on navigation. Pages render inner content only.
export function ShellChrome({ owner, agents, csrfToken, children }: {
  owner: OwnerChip;
  agents: AgentSummary[];
  csrfToken?: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  return (
    <AppShell owner={owner} agents={agents} csrfToken={csrfToken} pageTitle={titleForPath(pathname)}>
      {children}
    </AppShell>
  );
}
