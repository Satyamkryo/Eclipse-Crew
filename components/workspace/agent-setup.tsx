"use client";

import Link from "next/link";
import { CheckCircle2, CircleAlert, LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useRemote } from "@/components/history/use-remote";

type ConnectionRow = { id: string; preset: "github" | "custom"; bindings: { host: string }[] };
type ServerRow = { id: string; key: string; status: "pinned" | "changed" | "disabled" };

// TASK-074. A checklist that reflects stored state, never a claim: each row is read from the same routes the dialogs use.
export function AgentSetup({ agentId, actions, tools, domains }: {
  agentId: string; actions: string[]; tools: string[]; domains: string[];
}) {
  const usesTools = actions.includes("tool_call") && tools.includes("github");
  const usesShell = actions.includes("shell");
  const connections = useRemote<{ connections: ConnectionRow[] }>(`/api/connections?agentId=${agentId}`, () => null);
  const servers = useRemote<{ servers: ServerRow[] }>(`/api/mcp-servers?agentId=${agentId}`, () => null);
  if (!usesTools && !usesShell) return null;

  const rows: { label: string; done: boolean; detail: string }[] = [
    {
      label: "GitHub connection saved",
      done: Boolean(connections.data?.connections.some((connection) => connection.preset === "github" || connection.bindings.some((binding) => binding.host === "github.com"))),
      detail: "Settings → Connections → Add connection",
    },
    {
      label: "GitHub MCP server pinned",
      done: Boolean(servers.data?.servers.some((server) => server.key === "github" && server.status === "pinned")),
      detail: servers.data?.servers.some((server) => server.key === "github" && server.status === "changed")
        ? "The tool list changed — review and re-pin it in Settings → Connections"
        : "Settings → Connections → MCP servers → Add MCP server",
    },
    ...(usesShell ? [{
      label: "github.com in Domains",
      done: domains.some((domain) => domain.toLowerCase() === "github.com"),
      detail: "Agent settings → Domains",
    }] : []),
  ];

  const loading = connections.loading || servers.loading;
  const failed = connections.error || servers.error;

  return (
    <section className="rounded-lg border border-border bg-card p-4" aria-labelledby="agent-setup-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="agent-setup-heading" className="text-sm font-semibold">Setup</h3>
        <Link href="/settings/connections" className="text-sm underline underline-offset-4">Open Connections</Link>
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
