"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, ExternalLink, LoaderCircle, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/workspace/modal-dialog";
import { useRemote } from "@/components/history/use-remote";
import {
  ConnectionPresetIcon,
  ConnectorIconTile,
  McpServerIcon,
  ToolkitIcon,
} from "@/components/workspace/connector-icons";
import { COMPOSIO_TOOLKITS } from "@/lib/composio/schema";
import { CONNECTION_PRESETS } from "@/lib/connections/presets";
import { cn } from "@/lib/utils";

type ConnectionRow = {
  id: string;
  preset: "github" | "custom";
  label: string;
  bindings: { host: string }[];
  status: "active" | "expired";
};

type ServerRow = {
  id: string;
  key: string;
  serverName: string;
  url: string;
  status: "pinned" | "changed" | "disabled";
  tools: unknown[];
};

type ComposioRow = {
  id: string;
  toolkit: string;
  status: "active" | "pending" | "failed" | "changed" | "revoked";
  toolCount: number;
};

type DeviceFlow = {
  id: string;
  status: "pending" | "connected" | "expired" | "denied" | "error";
  userCode: string;
  verificationUri: string;
  installUrl: string;
  expiresAt: string;
  error: string | null;
  connectionId: string | null;
};

function toolkitLabel(slug: string) {
  return COMPOSIO_TOOLKITS.find((item) => item.slug === slug)?.label ?? slug;
}

const inputClass = "h-8 w-full rounded-md border border-input bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

function connectErrorMessage(code: string | undefined): string {
  if (code === "label_taken") return "That label is already used for this agent.";
  if (code === "connection_limit") return "This agent already has 8 connections. Remove one first.";
  if (code === "agent_inactive") return "Activate this agent before connecting.";
  if (code === "github_app_not_configured") return "GitHub App not configured. Set GITHUB_APP_CLIENT_ID first.";
  if (code === "composio_not_configured") return "Save a Composio API key in Integrations first.";
  if (code === "already_connected") return "This agent already has an account for that app.";
  if (code === "managed_auth_unavailable") return "This app needs its own OAuth credentials, which v1 doesn't support.";
  if (code === "invalid_input") return "Review the values and try again.";
  return "Couldn't connect. Try again.";
}

// Per-agent Tools tab: connect GitHub or a plugin app directly for this agent,
// then review what this agent can already use. MCP pins stay in Connectors;
// API keys stay in Integrations.
export function AgentToolsPanel({ agentId, agentName, csrfToken }: { agentId: string; agentName: string; csrfToken: string }) {
  const router = useRouter();
  const connections = useRemote<{ connections: ConnectionRow[] }>(
    `/api/connections?agentId=${agentId}`,
    () => null,
  );
  const servers = useRemote<{ servers: ServerRow[] }>(`/api/mcp-servers?agentId=${agentId}`, () => null);
  const accounts = useRemote<{ accounts: ComposioRow[] }>(
    `/api/composio/accounts?agentId=${agentId}`,
    () => null,
  );

  const loading = connections.loading || servers.loading || accounts.loading;
  const failed = connections.error || servers.error || accounts.error;
  const connectionRows = connections.data?.connections ?? [];
  const serverRows = servers.data?.servers ?? [];
  const accountRows = (accounts.data?.accounts ?? []).filter((row) => row.status !== "revoked");
  const empty = connectionRows.length === 0 && serverRows.length === 0 && accountRows.length === 0;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  const [githubFlow, setGithubFlow] = useState<DeviceFlow | null>(null);
  const [githubLabel, setGithubLabel] = useState("GitHub");
  const [githubFormOpen, setGithubFormOpen] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [pluginToolkit, setPluginToolkit] = useState<string | null>(null);
  const [pluginRedirect, setPluginRedirect] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function fail(message: string) {
    setError(message);
    requestAnimationFrame(() => errorRef.current?.focus());
  }

  function retry() {
    setError(null);
    connections.reload();
    servers.reload();
    accounts.reload();
  }

  function refreshLists() {
    connections.reload();
    servers.reload();
    accounts.reload();
    router.refresh();
  }

  async function startGithubApp() {
    setBusy(true);
    setError(null);
    setGithubFlow(null);
    setCopied(false);
    try {
      const response = await fetch("/api/connections/github/device", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ agentId, label: githubLabel.trim() || "GitHub" }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        fail(connectErrorMessage(body.error));
        return;
      }
      setGithubFlow(body as DeviceFlow);
    } catch {
      fail("Unable to reach the app. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function copyCode() {
    if (!githubFlow) return;
    try {
      await navigator.clipboard.writeText(githubFlow.userCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      fail("Copy failed. Select the code and copy it manually.");
    }
  }

  useEffect(() => {
    if (!githubFlow || githubFlow.status !== "pending") return;
    const flowId = githubFlow.id;
    let active = true;
    const tick = async () => {
      try {
        const response = await fetch(`/api/connections/github/device/${flowId}`);
        if (!active) return;
        if (!response.ok) return;
        const body = await response.json().catch(() => ({}));
        if (!active) return;
        setGithubFlow(body as DeviceFlow);
        if (body.status === "connected") {
          refreshLists();
          setStatus("GitHub connected for this agent.");
        }
      } catch {
        // A missed poll is harmless; the next tick asks again.
      }
    };
    const timer = window.setInterval(tick, 3_000);
    return () => { active = false; window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [githubFlow?.id, githubFlow?.status]);

  async function addToken(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({
          agentId,
          preset: "github",
          label: String(data.get("label") ?? "GitHub"),
          token: String(data.get("token") ?? ""),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        fail(connectErrorMessage(body.error));
        return;
      }
      setTokenOpen(false);
      setStatus("GitHub token saved for this agent.");
      refreshLists();
    } catch {
      fail("Unable to connect. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function connectPlugin(toolkit: string) {
    setBusy(true);
    setError(null);
    setPluginRedirect(null);
    try {
      const response = await fetch("/api/composio/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ agentId, toolkit }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        fail(connectErrorMessage(body.error));
        return;
      }
      setPluginRedirect(body.redirectUrl as string);
      setStatus(`Open the Composio link, sign in, then press Check status in Connectors.`);
      refreshLists();
    } catch {
      fail("Unable to connect. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto p-6">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Tools for {agentName}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Connect GitHub or a plugin app for this agent, then review what it can use.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" size="sm" asChild>
              <Link href={`/settings/integrations?agent=${agentId}`}>Manage keys</Link>
            </Button>
            <Button type="button" variant="ghost" size="sm" asChild>
              <Link href={`/settings/connections?agent=${agentId}`}>Manage pins</Link>
            </Button>
          </div>
        </div>

        {error && <p ref={errorRef} role="alert" tabIndex={-1} className="text-sm text-danger">{error}</p>}
        {status && <p role="status" aria-live="polite" className="text-sm text-success">{status}</p>}

        <section className="rounded-lg border border-border bg-card p-4" aria-label={`Add tools for ${agentName}`}>
          <h3 className="text-sm font-semibold">Add tools</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick a card to connect it to {agentName}. API keys live in Integrations; MCP pins live in Connectors.
          </p>
          <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label="Available tools">
            {/* GitHub connects through the native card above; the plugin list skips it so it never appears twice. */}
            <li className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3">
              <ConnectorIconTile label="GitHub">
                <ConnectionPresetIcon preset="github" />
              </ConnectorIconTile>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">GitHub</span>
              <Button type="button" variant="secondary" size="sm" aria-label={`Connect GitHub to ${agentName}`}
                onClick={() => { setGithubFormOpen(true); setGithubFlow(null); setError(null); }}>
                <Plus aria-hidden="true" className="size-3.5" /> Connect
              </Button>
            </li>
            {COMPOSIO_TOOLKITS.filter((toolkit) => toolkit.slug !== "github").map((toolkit) => (
              <li key={toolkit.slug} className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3">
                <ConnectorIconTile label={toolkit.label}>
                  <ToolkitIcon slug={toolkit.slug} />
                </ConnectorIconTile>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{toolkit.label}</span>
                <Button type="button" variant="secondary" size="sm" aria-label={`Connect ${toolkit.label} to ${agentName}`}
                  disabled={busy && pluginToolkit === toolkit.slug}
                  onClick={() => { setPluginToolkit(toolkit.slug); setPluginRedirect(null); setError(null); void connectPlugin(toolkit.slug); }}>
                  {busy && pluginToolkit === toolkit.slug
                    ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
                    : <Plus aria-hidden="true" className="size-3.5" />}
                  Connect
                </Button>
              </li>
            ))}
            <li className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3">
              <ConnectorIconTile label="MCP server">
                <McpServerIcon />
              </ConnectorIconTile>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">MCP server</span>
              <Button type="button" variant="secondary" size="sm" asChild>
                <Link href={`/settings/connections?agent=${agentId}`} aria-label={`Pin an MCP server for ${agentName}`}>
                  <Plus aria-hidden="true" className="size-3.5" /> Pin
                </Link>
              </Button>
            </li>
          </ul>
          {pluginRedirect && pluginToolkit && (
            <p className="mt-3 text-sm">
              <a href={pluginRedirect} target="_blank" rel="noreferrer noopener" className="underline underline-offset-4">
                Open Composio to sign in {toolkitLabel(pluginToolkit)}
              </a>
              <span className="ml-2 text-muted-foreground">Then check status in Connectors.</span>
            </p>
          )}
        </section>

        {loading && !connections.data && !servers.data && !accounts.data ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> Loading tools…
          </p>
        ) : failed && empty ? (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-sm text-danger">Couldn&apos;t load this agent&apos;s tools.</p>
            <Button type="button" variant="secondary" size="sm" onClick={retry}>
              Retry
            </Button>
          </div>
        ) : empty ? (
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-sm font-medium">No tools connected for this agent yet.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Use a card above to connect GitHub or a plugin app, or pin an MCP server in Connectors.
            </p>
          </div>
        ) : (
          <>
            <section className="rounded-lg border border-border bg-card p-4" aria-label={`Connections for ${agentName}`}>
              <h3 className="text-sm font-semibold">Connections</h3>
              {connectionRows.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">No connections yet.</p>
              ) : (
                <ul className="mt-2 divide-y divide-border border-t border-border">
                  {connectionRows.map((connection) => (
                    <li key={connection.id} className="flex items-start gap-3 py-3">
                      <ConnectorIconTile label={CONNECTION_PRESETS[connection.preset].label}>
                        <ConnectionPresetIcon preset={connection.preset} host={connection.bindings[0]?.host} />
                      </ConnectorIconTile>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{connection.label}</p>
                        <p className="truncate font-mono text-xs text-muted-foreground">
                          {CONNECTION_PRESETS[connection.preset].label} ·{" "}
                          {connection.bindings.map((binding) => binding.host).join(", ")}
                        </p>
                        {connection.status === "expired" && (
                          <p className="mt-0.5 text-xs text-danger">Expired — reconnect in Integrations.</p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-lg border border-border bg-card p-4" aria-label={`MCP servers for ${agentName}`}>
              <h3 className="text-sm font-semibold">MCP servers</h3>
              {serverRows.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">No MCP servers pinned.</p>
              ) : (
                <ul className="mt-2 divide-y divide-border border-t border-border">
                  {serverRows.map((server) => (
                    <li key={server.id} className="flex items-start gap-3 py-3">
                      <ConnectorIconTile label={server.key}>
                        <McpServerIcon url={server.url} />
                      </ConnectorIconTile>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          <span className="font-mono">{server.key}</span> · {server.serverName}
                        </p>
                        <p className="truncate font-mono text-xs text-muted-foreground">{server.url}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {server.status === "pinned"
                            ? `Pinned · ${server.tools.length} tools`
                            : server.status === "changed"
                              ? "Changed — review in Connectors"
                              : "Disabled"}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-lg border border-border bg-card p-4" aria-label={`Connected apps for ${agentName}`}>
              <h3 className="text-sm font-semibold">Connected apps</h3>
              {accountRows.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">No connected apps yet.</p>
              ) : (
                <ul className="mt-2 divide-y divide-border border-t border-border">
                  {accountRows.map((account) => (
                    <li key={account.id} className="flex items-start gap-3 py-3">
                      <ConnectorIconTile label={toolkitLabel(account.toolkit)}>
                        <ToolkitIcon slug={account.toolkit} />
                      </ConnectorIconTile>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{toolkitLabel(account.toolkit)}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {account.status === "active"
                            ? `Active · ${account.toolCount} tools pinned`
                            : account.status === "pending"
                              ? "Waiting for sign-in — finish in Connectors"
                              : account.status === "changed"
                                ? "Tools changed — review in Connectors"
                                : account.status === "failed"
                                  ? "Link expired — connect again above"
                                  : "Disconnected"}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>

      {githubFormOpen && (
        <ModalDialog title={`Connect GitHub for ${agentName}`}
          description="Approve a short code on github.com, or paste a fine-grained token instead. The token is encrypted on this machine and never shown again."
          onClose={() => { setGithubFormOpen(false); setGithubFlow(null); }}>
          {!githubFlow ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <label htmlFor="tools-github-label" className="text-sm font-medium">Label</label>
                <input id="tools-github-label" value={githubLabel} onChange={(event) => setGithubLabel(event.target.value)}
                  required maxLength={60} autoComplete="off" className={inputClass} />
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => { setGithubFormOpen(false); setTokenOpen(true); }}>
                  Paste a token instead
                </Button>
                <span className="flex-1" />
                <Button type="button" variant="secondary" onClick={() => setGithubFormOpen(false)} disabled={busy}>Cancel</Button>
                <Button type="button" onClick={startGithubApp} disabled={busy}>
                  {busy && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
                  Connect GitHub
                </Button>
              </div>
            </div>
          ) : githubFlow.status === "pending" ? (
            <div className="flex flex-col gap-4">
              <p className="text-sm">On github.com, open the link and enter this code:</p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="select-all rounded-md border border-border bg-surface px-3 py-2 font-mono text-lg tracking-widest">
                  {githubFlow.userCode}
                </code>
                <Button type="button" variant="secondary" size="sm" onClick={copyCode}>
                  {copied ? <Check aria-hidden="true" className="size-3.5" /> : <Copy aria-hidden="true" className="size-3.5" />}
                  {copied ? "Copied" : "Copy code"}
                </Button>
              </div>
              <div className="flex flex-col gap-1 text-sm">
                <a href={githubFlow.verificationUri} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground">
                  <ExternalLink aria-hidden="true" className="size-3.5" /> Open github.com/login/device
                </a>
                <a href={githubFlow.installUrl} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 text-muted-foreground underline underline-offset-2 hover:text-foreground">
                  <ExternalLink aria-hidden="true" className="size-3.5" /> Install the app on these repositories
                </a>
              </div>
              <p role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-muted-foreground">
                <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
                Waiting for approval. This code expires at {new Date(githubFlow.expiresAt).toLocaleTimeString()}.
              </p>
              <div className="flex justify-end">
                <Button type="button" variant="secondary" onClick={() => { setGithubFormOpen(false); setGithubFlow(null); }}>Cancel</Button>
              </div>
            </div>
          ) : githubFlow.status === "connected" ? (
            <div className="flex flex-col gap-4">
              <p role="status" className="text-sm text-success">
                GitHub connected for {agentName}. It can now clone private repositories, push branches and open pull requests where the app is installed.
              </p>
              <div className="flex justify-end">
                <Button type="button" onClick={() => { setGithubFormOpen(false); setGithubFlow(null); }}>Done</Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <p role="alert" className="text-sm text-danger">
                {githubFlow.status === "denied" ? "The sign-in was denied on GitHub."
                  : "The code expired or GitHub could not complete the sign-in."}
              </p>
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => { setGithubFormOpen(false); setGithubFlow(null); }}>Close</Button>
                <Button type="button" onClick={() => { setGithubFlow(null); }}>Try again</Button>
              </div>
            </div>
          )}
        </ModalDialog>
      )}

      {tokenOpen && (
        <ModalDialog title={`Add GitHub token for ${agentName}`}
          description="Use a fine-grained token. It is encrypted on this machine and never shown again."
          onClose={() => setTokenOpen(false)}>
          <form onSubmit={addToken} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <label htmlFor="tools-token-label" className="text-sm font-medium">Label</label>
              <input id="tools-token-label" name="label" required maxLength={60} defaultValue="GitHub"
                autoComplete="off" className={inputClass} />
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="tools-token" className="text-sm font-medium">Token</label>
              <input id="tools-token" name="token" type="password" required minLength={8} maxLength={4096}
                autoComplete="new-password" spellCheck={false} className={cn(inputClass, "font-mono")} />
              <p className="text-xs text-muted-foreground">
                Create one at github.com/settings/personal-access-tokens/new with Contents read/write and Pull requests read/write.
              </p>
            </div>
            <input type="hidden" name="preset" value="github" />
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setTokenOpen(false)} disabled={busy}>Cancel</Button>
              <Button type="submit" disabled={busy}>
                {busy && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
                Save connection
              </Button>
            </div>
          </form>
        </ModalDialog>
      )}
    </div>
  );
}
