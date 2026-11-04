"use client";

import Link from "next/link";
import { CheckCircle2, CircleAlert, LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useRemote } from "@/components/history/use-remote";
import { setupNeedsRemote, setupRows } from "@/lib/agents/setup";

type ConnectionRow = { id: string; preset: "github" | "custom"; bindings: { host: string }[] };
type ServerRow = { id: string; key: string; status: "pinned" | "changed" | "disabled" };

// TASK-074/058. A checklist that reflects stored state, never a claim: each row is read from the same routes the dialogs
// use. Roles that are not on GitHub get only the generic rows their real policy can satisfy; no mail or calendar tool
// name is invented here.
export function AgentSetup({ agentId, actions, tools, domains, anyPublicWeb = false }: {
  agentId: string; actions: string[]; tools: string[]; domains: string[]; anyPublicWeb?: boolean;
}) {
  const connections = useRemote<{ connections: ConnectionRow[] }>(`/api/connections?agentId=${agentId}`, () => null);
  const servers = useRemote<{ servers: ServerRow[] }>(`/api/mcp-servers?agentId=${agentId}`, () => null);
  const rows = setupRows(actions, tools, domains, {
    connections: connections.data?.connections ?? [],
    servers: servers.data?.servers ?? [],
  }, anyPublicWeb);
  if (rows.length === 0) return null;
  const needsRemote = setupNeedsRemote(actions, tools);
  const loading = needsRemote && (connections.loading || servers.loading);
  const failed = needsRemote && (connections.error || servers.error);

  return (
    <section className="rounded-lg border border-border bg-card p-4" aria-labelledby="agent-setup-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="agent-setup-heading" className="text-sm font-semibold">Setup</h3>
        {needsRemote && (
          <Link href="/settings/connections" className="text-sm underline underline-offset-4">Open Connections</Link>
        )}
      </div>
      {loading ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> Checking saved setup…
        </p>
      ) : failed ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-danger">Couldn&apos;t check the saved setup.</p>
          <Button type="button" variant="secondary" size="sm" onClick={() => { connections.reload(); servers.reload(); }}>Retry</Button>
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-border border-t border-border">
          {rows.map((row) => (
            <li key={row.label} className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="text-sm">{row.label}</p>
                {!row.done && <p className="mt-0.5 text-xs text-muted-foreground">{row.detail}</p>}
              </div>
              <span className={cnTone(row.done)}>
                {row.done
                  ? <><CheckCircle2 aria-hidden="true" className="size-3.5" /> Done</>
                  : <><CircleAlert aria-hidden="true" className="size-3.5" /> Missing</>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function cnTone(done: boolean) {
  return done
    ? "inline-flex shrink-0 items-center gap-1 text-xs text-success"
    : "inline-flex shrink-0 items-center gap-1 text-xs text-corona";
}
