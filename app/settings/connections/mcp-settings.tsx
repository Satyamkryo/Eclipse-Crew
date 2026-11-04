"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { ModalDialog } from "@/components/workspace/modal-dialog";
import type { McpDiscoveryView, McpServerView } from "@/lib/mcp/view";
import { cn } from "@/lib/utils";

export type AgentOption = { id: string; name: string; status: "active" | "paused" };
export type ConnectionOption = { id: string; agentId: string; label: string; preset: "github" | "custom" };

const inputClass = "h-8 w-full rounded-md border border-input bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

type Review = {
  mode: "add" | "repin";
  serverId?: string;
  payload: { agentId: string; preset: "github" | "custom"; key: string; url?: string; connectionId: string };
  discovery: McpDiscoveryView;
};

function errorMessage(code: string | undefined): string {
  if (code === "token_rejected") return "The saved token was rejected. Replace it in Connections, then try again.";
  if (code === "not_an_mcp_server") return "This URL did not answer as an MCP server.";
  if (code === "server_unreachable") return "The server could not be reached. Check the URL and the agent's network access.";
  if (code === "tools_changed") return "The server's tools changed. Review the new list and pin it again.";
  if (code === "key_taken") return "That server key is already used for this agent.";
  if (code === "host_not_in_connection") return "Add a connection for this host first; the token is only injected for its own hosts.";
  if (code === "invalid_url" || code === "url_required") return "Enter an HTTPS MCP server URL.";
  if (code === "tools_too_large") return "The server returned too many tools to review.";
  if (code === "rate_limited") return "Too many discovery attempts. Wait a minute and try again.";
  if (code === "invalid_input") return "Review the values and try again.";
  return "Couldn't complete the request. Try again.";
}

export function McpSettings({ initial, agents, connections, csrfToken }: {
  initial: McpServerView[]; agents: AgentOption[]; connections: ConnectionOption[]; csrfToken: string;
}) {
  const router = useRouter();
  const [servers, setServers] = useState(initial);
  const [adding, setAdding] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [removing, setRemoving] = useState<McpServerView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const errorRef = useRef<HTMLParagraphElement>(null);

  const agentConnections = useMemo(() => connections.filter((connection) => connection.agentId === agentId), [connections, agentId]);
  const grouped = useMemo(() => agents
    .map((agent) => ({ agent, rows: servers.filter((server) => server.agentId === agent.id) }))
    .filter((group) => group.rows.length > 0), [agents, servers]);

  function fail(message: string) {
    setError(message);
    requestAnimationFrame(() => errorRef.current?.focus());
  }

  async function handle(response: Response) {
    if (response.status === 401) {
      router.push("/login");
      router.refresh();
      return null;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      fail(errorMessage(body.error));
      return null;
    }
    return body;
  }

  async function discover(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const preset = String(data.get("preset")) as "github" | "custom";
    const payload = {
      agentId: String(data.get("agentId")),
      preset,
      key: String(data.get("key")),
      connectionId: String(data.get("connectionId")),
      ...(preset === "custom" ? { url: String(data.get("url")) } : {}),
    };
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(payload),
      });
      const body = await handle(response);
      if (!body) return;
      if (body.discovery) {
        setReview({ mode: "add", payload, discovery: body.discovery as McpDiscoveryView });
        return;
      }
      setServers((current) => [...current, body as McpServerView]);
      setAdding(false);
      setStatus("MCP server pinned.");
      router.refresh();
    } catch {
      fail("Unable to connect. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function repin(server: McpServerView) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/mcp-servers/${server.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({}),
      });
      const body = await handle(response);
      if (!body) return;
      if (body.discovery) {
        setReview({ mode: "repin", serverId: server.id, payload: { agentId: server.agentId, preset: server.preset, key: server.key, url: server.url, connectionId: "" }, discovery: body.discovery as McpDiscoveryView });
      }
    } catch {
      fail("Unable to connect. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmPin() {
    if (!review) return;
    setBusy(true);
    setError(null);
    try {
      const response = review.mode === "add"
        ? await fetch("/api/mcp-servers", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
          body: JSON.stringify({ ...review.payload, expectedToolsHash: review.discovery.toolsHash }),
        })
        : await fetch(`/api/mcp-servers/${review.serverId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
          body: JSON.stringify({ expectedToolsHash: review.discovery.toolsHash }),
        });
      const body = await handle(response);
      if (!body) return;
      const server = body as McpServerView;
      setServers((current) => current.some((row) => row.id === server.id)
        ? current.map((row) => row.id === server.id ? server : row)
        : [...current, server]);
      setStatus(`Pinned ${server.tools.length} tool${server.tools.length === 1 ? "" : "s"} for ${server.key}.`);
      setReview(null);
      setAdding(false);
      router.refresh();
    } catch {
      fail("Unable to connect. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!removing) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/mcp-servers/${removing.id}`, {
        method: "DELETE",
        headers: { "x-csrf-token": csrfToken },
      });
      if (response.status === 401) {
        router.push("/login");
        router.refresh();
        return;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        fail(errorMessage(body.error));
        return;
      }
      setServers((current) => current.filter((row) => row.id !== removing.id));
      setStatus(`${removing.key} removed.`);
      setRemoving(null);
      router.refresh();
    } catch {
      fail("Unable to connect. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">MCP servers</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Pinned remote tool servers. A changed tool list blocks calls until you review and pin it again.
          </p>
        </div>
        <Button type="button" size="sm" disabled={agents.length === 0} onClick={() => { setAdding(true); setError(null); }}>
          <Plus aria-hidden="true" className="size-3.5" /> Add MCP server
        </Button>
      </div>

      {error && <p ref={errorRef} role="alert" tabIndex={-1} className="text-sm text-danger">{error}</p>}
      {status && <p role="status" aria-live="polite" className="text-sm text-success">{status}</p>}

      {grouped.length === 0 ? (
        <p className="text-sm text-muted-foreground">No MCP servers yet.</p>
      ) : (
        <div className="flex flex-col gap-6">
          {grouped.map(({ agent, rows }) => (
            <section key={agent.id} className="rounded-lg border border-border bg-card p-4" aria-label={`MCP servers for ${agent.name}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold">{agent.name}</h3>
                <span className="text-xs text-muted-foreground">{agent.status === "active" ? "Active" : "Paused"}</span>
              </div>
              <ul className="mt-3 divide-y divide-border border-t border-border">
                {rows.map((server) => (
                  <li key={server.id} className="flex flex-col gap-2 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          <span className="font-mono">{server.key}</span> · {server.serverName}
                        </p>
                        <p className="truncate font-mono text-xs text-muted-foreground">{server.url}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {server.status === "pinned" ? `Pinned · ${server.tools.length} tools` : server.status === "changed" ? "Changed — review" : "Disabled"}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" variant="secondary" size="sm" disabled={busy}
                          onClick={() => {
                            setReview({
                              mode: "repin", serverId: server.id,
                              payload: { agentId: server.agentId, preset: server.preset, key: server.key, url: server.url, connectionId: "" },
                              discovery: {
                                serverName: server.serverName, serverVersion: server.serverVersion,
                                protocolVersion: server.protocolVersion, toolsHash: server.toolsHash,
                                url: server.url, host: new URL(server.url).hostname, tools: server.tools,
                              },
                            });
                          }}>
                          View tools
                        </Button>
                        <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => repin(server)}>
                          Re-pin
                        </Button>
                        <Button type="button" variant="ghost" size="sm" onClick={() => { setRemoving(server); setError(null); }}>
                          Remove
                        </Button>
                      </div>
                    </div>
                    {server.status === "changed" && <p className="text-xs text-corona">The server&apos;s tools no longer match the pin. Calls are blocked until you re-pin.</p>}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {adding && (
        <ModalDialog title="Add MCP server" description="The app discovers the tools through the agent's saved connection. Nothing is pinned until you confirm the list." onClose={() => setAdding(false)}>
          <form onSubmit={discover} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <label htmlFor="mcp-agent" className="text-sm font-medium">Agent</label>
              <Select label="Agent" id="mcp-agent" name="agentId" required value={agentId} onChange={setAgentId}
                className="w-full [&>span]:w-full" selectClassName={cn(inputClass, "w-full")}>
                {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="mcp-connection" className="text-sm font-medium">Connection</label>
              <Select label="Connection" id="mcp-connection" name="connectionId" required disabled={agentConnections.length === 0}
                className="w-full [&>span]:w-full" selectClassName={cn(inputClass, "w-full")}>
                {agentConnections.map((connection) => (
                  <option key={connection.id} value={connection.id}>{connection.label} · {connection.preset}</option>
                ))}
              </Select>
              {agentConnections.length === 0 && <p className="text-xs text-muted-foreground">Add a connection for this agent first.</p>}
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="mcp-preset" className="text-sm font-medium">Server</label>
              <Select label="Server" id="mcp-preset" name="preset" defaultValue="github"
                className="w-full [&>span]:w-full" selectClassName={cn(inputClass, "w-full")}>
                <option value="github">GitHub (hosted MCP server)</option>
                <option value="custom">Custom HTTPS URL</option>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="mcp-key" className="text-sm font-medium">Key</label>
              <input id="mcp-key" name="key" required maxLength={32} pattern="[a-z0-9-]{1,32}" placeholder="github" spellCheck={false}
                autoComplete="off" className={cn(inputClass, "font-mono")} />
              <p className="text-xs text-muted-foreground">The name the model uses in <span className="font-mono">tool_call</span>, and the agent&apos;s Tools entry.</p>
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="mcp-url" className="text-sm font-medium">URL (custom only)</label>
              <input id="mcp-url" name="url" type="url" maxLength={2048} placeholder="https://mcp.example.com/mcp" spellCheck={false}
                autoComplete="off" className={cn(inputClass, "font-mono")} />
              <p className="text-xs text-muted-foreground">The host must match one of the connection&apos;s hosts.</p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setAdding(false)} disabled={busy}>Cancel</Button>
              <Button type="submit" disabled={busy || agentConnections.length === 0}>
                {busy && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
                Discover tools
              </Button>
            </div>
          </form>
        </ModalDialog>
      )}

      {review && (
        <ModalDialog title={review.mode === "add" ? "Review tools before pinning" : "Review the changed tool list"}
          description={`${review.discovery.serverName} · ${review.discovery.host}. Pinning records this exact list; a later change blocks calls.`}
          onClose={() => setReview(null)}>
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              {review.discovery.tools.length} tools · <span className="font-mono text-xs">{review.discovery.toolsHash.slice(0, 12)}…</span>
            </p>
            <ul className="max-h-72 overflow-y-auto border-y border-border" aria-label="Discovered tools">
              {review.discovery.tools.map((tool) => (
                <li key={tool.name} className="border-b border-border px-1 py-2 last:border-b-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="break-all font-mono text-xs">{tool.name}</span>
                    <span className={cn("text-xs", tool.write ? "text-corona" : "text-muted-foreground")}>{tool.write ? "Write (may need approval)" : "Read"}</span>
                  </div>
                  {tool.description && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{tool.description}</p>}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setReview(null)} disabled={busy}>Cancel</Button>
              <Button type="button" onClick={confirmPin} disabled={busy}>
                {busy && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
                Pin {review.discovery.tools.length} tools
              </Button>
            </div>
          </div>
        </ModalDialog>
      )}

      {removing && (
        <ModalDialog title={`Remove ${removing.key}?`} description="The pin is deleted. The agent can no longer call this server's tools." onClose={() => setRemoving(null)}>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setRemoving(null)} disabled={busy}>Keep it</Button>
            <Button type="button" variant="destructive" onClick={remove} disabled={busy}>
              {busy && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
              Remove server
            </Button>
          </div>
        </ModalDialog>
      )}
    </div>
  );
}
