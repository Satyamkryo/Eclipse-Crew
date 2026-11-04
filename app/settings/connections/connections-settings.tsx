"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, ExternalLink, GitBranch, LoaderCircle, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { ModalDialog } from "@/components/workspace/modal-dialog";
import { CONNECTION_PRESETS } from "@/lib/connections/presets";
import type { ConnectionBinding, ConnectionPreset } from "@/lib/connections/schema";
import { cn } from "@/lib/utils";

export type AgentOption = { id: string; name: string; status: "active" | "paused" };

export type ConnectionView = {
  id: string;
  agentId: string;
  preset: ConnectionPreset;
  label: string;
  bindings: ConnectionBinding[];
  hasToken: true;
  tokenHint: string;
  source: "pasted" | "github_app";
  status: "active" | "expired";
  tokenExpiresAt: string | null;
  refreshExpiresAt: string | null;
  createdAt: string;
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

type TestState = { status: "accepted" | "rejected" | "unreachable"; latencyMs: number } | { error: string };

const inputClass = "h-8 w-full rounded-md border border-input bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

function errorMessage(code: string | undefined): string {
  if (code === "label_taken") return "That label is already used for this agent.";
  if (code === "connection_limit") return "This agent already has 8 connections. Remove one first.";
  if (code === "encryption_unavailable") return "Encryption is not configured. Set the encryption key first.";
  if (code === "invalid_input") return "Review the values and try again.";
  if (code === "rate_limited") return "Too many tests. Wait a minute and try again.";
  if (code === "test_unsupported") return "Test is only available for GitHub connections.";
  if (code === "not_found") return "That connection is gone. Reload the page.";
  if (code === "github_app_not_configured") return "GitHub App not configured. Set GITHUB_APP_CLIENT_ID to your GitHub App's client ID.";
  if (code === "github_unreachable") return "GitHub could not be reached. Check the connection and try again.";
  if (code === "agent_inactive") return "Activate this agent before connecting GitHub.";
  if (code === "invalid_device_request") return "The sign-in request was refused. Try again.";
  return "Couldn't save the connection. Try again.";
}

function testLabel(state: TestState | undefined) {
  if (!state) return null;
  if ("error" in state) return { text: state.error, tone: "text-danger" as const };
  if (state.status === "accepted") return { text: `Accepted · ${state.latencyMs} ms`, tone: "text-success" as const };
  if (state.status === "rejected") return { text: "Rejected: GitHub refused this token.", tone: "text-danger" as const };
  return { text: "Unreachable: check the network and try again.", tone: "text-muted-foreground" as const };
}

export function ConnectionsSettings({ initial, agents, csrfToken, installUrl }: {
  initial: ConnectionView[]; agents: AgentOption[]; csrfToken: string; installUrl: string;
}) {
  const router = useRouter();
  const [connections, setConnections] = useState(initial);
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState<ConnectionView | null>(null);
  const [removing, setRemoving] = useState<ConnectionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<{ agentId: string; label: string } | null>(null);
  const [flow, setFlow] = useState<DeviceFlow | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectBusy, setConnectBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const connectErrorRef = useRef<HTMLParagraphElement>(null);

  const grouped = useMemo(() => agents
    .map((agent) => ({ agent, rows: connections.filter((row) => row.agentId === agent.id) }))
    .filter((group) => group.rows.length > 0), [agents, connections]);

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

  async function addConnection(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const preset = String(data.get("preset")) as ConnectionPreset;
    const scheme = String(data.get("scheme") ?? "bearer");
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({
          agentId: data.get("agentId"),
          preset,
          label: data.get("label"),
          token: data.get("token"),
          ...(preset === "custom" ? { host: data.get("host"), scheme } : {}),
        }),
      });
      const created = await handle(response) as ConnectionView | null;
      if (!created) return;
      setConnections((current) => [...current, created].sort((a, b) => a.label.localeCompare(b.label)));
      setAdding(false);
      setStatus(`${CONNECTION_PRESETS[preset].label} connection saved for ${agents.find((agent) => agent.id === created.agentId)?.name ?? "agent"}.`);
      router.refresh();
    } catch {
      fail("Unable to connect. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function replaceToken(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!replacing) return;
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const token = String(new FormData(form).get("token") ?? "");
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/connections/${replacing.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ token }),
      });
      const updated = await handle(response) as ConnectionView | null;
      if (!updated) return;
      setConnections((current) => current.map((row) => row.id === updated.id ? updated : row));
      setReplacing(null);
      setStatus("Token replaced.");
      router.refresh();
    } catch {
      fail("Unable to connect. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function removeConnection() {
    if (!removing) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/connections/${removing.id}`, {
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
      setConnections((current) => current.filter((row) => row.id !== removing.id));
      setStatus(`${removing.label} removed. The proxy stops injecting its token.`);
      setRemoving(null);
      router.refresh();
    } catch {
      fail("Unable to connect. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function runTest(connection: ConnectionView) {
    setTesting(connection.id);
    setTests((current) => ({ ...current, [connection.id]: undefined as unknown as TestState }));
    try {
      const response = await fetch(`/api/connections/${connection.id}/test`, {
        method: "POST",
        headers: { "x-csrf-token": csrfToken },
      });
      if (response.status === 401) {
        router.push("/login");
        router.refresh();
        return;
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setTests((current) => ({ ...current, [connection.id]: { error: errorMessage(body.error) } }));
        return;
      }
      setTests((current) => ({ ...current, [connection.id]: body as TestState }));
    } catch {
      setTests((current) => ({ ...current, [connection.id]: { error: "Unable to connect. Try again." } }));
    } finally {
      setTesting(null);
    }
  }

  function openConnect(agentId?: string, label?: string) {
    const target = agentId ?? agents[0]?.id;
    if (!target) return;
    setConnecting({ agentId: target, label: label ?? "GitHub" });
    setFlow(null);
    setConnectError(null);
    setCopied(false);
  }

  function closeConnect() {
    setConnecting(null);
    setFlow(null);
    setConnectError(null);
    setCopied(false);
  }

  async function refreshConnections() {
    const response = await fetch("/api/connections");
    if (response.status === 401) {
      router.push("/login");
      router.refresh();
      return;
    }
    const body = await response.json().catch(() => ({}));
    if (response.ok) setConnections(body.connections as ConnectionView[]);
  }

  async function startConnect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!connecting) return;
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const agentId = String(data.get("agentId") ?? connecting.agentId);
    const label = String(data.get("label") ?? connecting.label).trim();
    setConnectBusy(true);
    setConnectError(null);
    try {
      const response = await fetch("/api/connections/github/device", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ agentId, label }),
      });
      if (response.status === 401) {
        router.push("/login");
        router.refresh();
        return;
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setConnectError(errorMessage(body.error));
        requestAnimationFrame(() => connectErrorRef.current?.focus());
        return;
      }
      setConnecting({ agentId, label });
      setFlow(body as DeviceFlow);
    } catch {
      setConnectError("Unable to reach the app. Try again.");
    } finally {
      setConnectBusy(false);
    }
  }

  async function copyCode() {
    if (!flow) return;
    try {
      await navigator.clipboard.writeText(flow.userCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setConnectError("Copy failed. Select the code and copy it manually.");
    }
  }

  useEffect(() => {
    if (!flow || flow.status !== "pending") return;
    const flowId = flow.id;
    let active = true;
    const tick = async () => {
      try {
        const response = await fetch(`/api/connections/github/device/${flowId}`);
        if (!active) return;
        if (response.status === 401) {
          router.push("/login");
          router.refresh();
          return;
        }
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !active) return;
        setFlow(body as DeviceFlow);
        if (body.status === "connected") {
          await refreshConnections();
          setStatus("GitHub connected. Press Test to check it.");
          router.refresh();
        }
      } catch {
        // A missed poll is harmless; the next tick asks again until the code expires.
      }
    };
    const timer = window.setInterval(tick, 3_000);
    return () => { active = false; window.clearInterval(timer); };
    // The poll restarts only for a new flow or a terminal state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow?.id, flow?.status]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">One token per agent and tool host. Nothing is shared between agents.</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => openConnect()} disabled={agents.length === 0}>
            <GitBranch aria-hidden="true" className="size-3.5" /> Connect GitHub
          </Button>
          <Button type="button" size="sm" onClick={() => { setAdding(true); setError(null); }} disabled={agents.length === 0}>
            <Plus aria-hidden="true" className="size-3.5" /> Add connection
          </Button>
        </div>
      </div>

      {error && <p ref={errorRef} role="alert" tabIndex={-1} className="text-sm text-danger">{error}</p>}
      {status && <p role="status" aria-live="polite" className="text-sm text-success">{status}</p>}
      {agents.length === 0 && <p className="text-sm text-muted-foreground">Create an agent first, then add a connection for it.</p>}

      {grouped.length === 0 && agents.length > 0 ? (
        <section className="rounded-lg border border-border bg-card p-4" aria-label="Connections">
          <p className="text-sm text-muted-foreground">No connections yet.</p>
        </section>
      ) : (
        <div className="flex flex-col gap-6">
          {grouped.map(({ agent, rows }) => (
            <section key={agent.id} className="rounded-lg border border-border bg-card p-4" aria-label={`Connections for ${agent.name}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-semibold tracking-tight">{agent.name}</h2>
                <span className="text-xs text-muted-foreground">{agent.status === "active" ? "Active" : "Paused"}</span>
              </div>
              <ul className="mt-3 divide-y divide-border border-t border-border">
                {rows.map((connection) => {
                  const result = testLabel(tests[connection.id]);
                  return (
                    <li key={connection.id} className="flex flex-col gap-2 py-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{connection.label}</p>
                          <p className="truncate font-mono text-xs text-muted-foreground">
                            {CONNECTION_PRESETS[connection.preset].label} · {connection.bindings.map((binding) => binding.host).join(", ")}
                          </p>
                          <p className="mt-0.5 font-mono text-xs text-subtle">
                            {connection.source === "github_app" ? "Connected (GitHub app)" : "Saved token"} {connection.tokenHint}
                          </p>
                          {connection.status === "expired" && (
                            <p role="status" className="mt-0.5 text-xs text-danger">
                              Expired. Reconnect GitHub to keep using this connection.
                            </p>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {connection.status === "expired" && (
                            <Button type="button" variant="secondary" size="sm" onClick={() => openConnect(connection.agentId, connection.label)}>
                              Reconnect
                            </Button>
                          )}
                          {connection.preset === "github" && (
                            <Button type="button" variant="secondary" size="sm" disabled={testing !== null || connection.status === "expired"}
                              onClick={() => runTest(connection)}>
                              {testing === connection.id && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
                              Test
                            </Button>
                          )}
                          <Button type="button" variant="secondary" size="sm" onClick={() => { setReplacing(connection); setError(null); }}>
                            Replace token
                          </Button>
                          <Button type="button" variant="ghost" size="sm" onClick={() => { setRemoving(connection); setError(null); }}>
                            Remove
                          </Button>
                        </div>
                      </div>
                      {result && <p role="status" className={cn("text-xs", result.tone)}>{result.text}</p>}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      {adding && (
        <ModalDialog title="Add connection" description="The token is encrypted on this machine and never shown again." onClose={() => setAdding(false)}>
          <form onSubmit={addConnection} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <label htmlFor="connection-agent" className="text-sm font-medium">Agent</label>
              <Select label="Agent" id="connection-agent" name="agentId" required
                className="w-full [&>span]:w-full" selectClassName={cn(inputClass, "w-full")}>
                {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="connection-preset" className="text-sm font-medium">Tool</label>
              <Select label="Tool" id="connection-preset" name="preset" required defaultValue="github"
                className="w-full [&>span]:w-full" selectClassName={cn(inputClass, "w-full")}>
                <option value="github">GitHub</option>
                <option value="custom">Custom host</option>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="connection-label" className="text-sm font-medium">Label</label>
              <input id="connection-label" name="label" required maxLength={60} placeholder="Work GitHub"
                autoComplete="off" className={inputClass} />
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="connection-token" className="text-sm font-medium">Token</label>
              <input id="connection-token" name="token" type="password" required minLength={8} maxLength={4096}
                autoComplete="new-password" spellCheck={false} className={cn(inputClass, "font-mono")} />
              <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                <p>Use a fine-grained token:</p>
                <ol className="flex list-decimal flex-col gap-0.5 pl-4">
                  <li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">github.com/settings/personal-access-tokens/new</a>.</li>
                  <li>Under repository access, choose only the repositories this agent may change.</li>
                  <li>Grant Contents read/write and Pull requests read/write (Metadata read is added by GitHub).</li>
                  <li>Paste the token here, then press Test on the saved connection.</li>
                </ol>
              </div>
            </div>
            <div className="flex flex-col gap-2 border-t border-border pt-4">
              <label htmlFor="connection-host" className="text-sm font-medium">Custom host (optional)</label>
              <input id="connection-host" name="host" maxLength={253} placeholder="api.example.com" spellCheck={false}
                autoComplete="off" className={cn(inputClass, "font-mono")} />
              <label htmlFor="connection-scheme" className="text-sm font-medium">Send the token as</label>
              <Select label="Send the token as" id="connection-scheme" name="scheme" defaultValue="bearer"
                className="w-full [&>span]:w-full" selectClassName={cn(inputClass, "w-full")}>
                <option value="bearer">Authorization: Bearer</option>
                <option value="header">Header: x-api-key</option>
              </Select>
              <p className="text-xs text-muted-foreground">Custom connections take one exact host. GitHub presets set their own hosts.</p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setAdding(false)} disabled={busy}>Cancel</Button>
              <Button type="submit" disabled={busy}>
                {busy && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
                Save connection
              </Button>
            </div>
          </form>
        </ModalDialog>
      )}

      {replacing && (
        <ModalDialog title={`Replace token for ${replacing.label}`} description="The old token stops working at the proxy immediately." onClose={() => setReplacing(null)}>
          <form onSubmit={replaceToken} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <label htmlFor="replace-token" className="text-sm font-medium">New token</label>
              <input id="replace-token" name="token" type="password" required minLength={8} maxLength={4096}
                autoComplete="new-password" spellCheck={false} className={cn(inputClass, "font-mono")} />
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setReplacing(null)} disabled={busy}>Cancel</Button>
              <Button type="submit" disabled={busy}>
                {busy && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
                Replace token
              </Button>
            </div>
          </form>
        </ModalDialog>
      )}

      {connecting && (
        <ModalDialog title="Connect GitHub"
          description="Approve a short code on github.com. The token is encrypted on this machine and never shown again."
          onClose={closeConnect}>
          {!flow ? (
            <form onSubmit={startConnect} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <label htmlFor="connect-agent" className="text-sm font-medium">Agent</label>
                <Select label="Agent" id="connect-agent" name="agentId" required defaultValue={connecting.agentId}
                  className="w-full [&>span]:w-full" selectClassName={cn(inputClass, "w-full")}>
                  {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <label htmlFor="connect-label" className="text-sm font-medium">Label</label>
                <input id="connect-label" name="label" required maxLength={60} defaultValue={connecting.label}
                  autoComplete="off" className={inputClass} />
              </div>
              <p className="text-xs text-muted-foreground">
                Install the GitHub App on the repositories this agent may change first:{" "}
                <a href={installUrl} target="_blank" rel="noreferrer"
                  className="underline underline-offset-2 hover:text-foreground">open the install page</a>.
                If the app is not installed on a repository, pushes to it fail with 403.
              </p>
              {connectError && <p ref={connectErrorRef} role="alert" tabIndex={-1} className="text-sm text-danger">{connectError}</p>}
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="secondary" onClick={closeConnect} disabled={connectBusy}>Cancel</Button>
                <Button type="submit" disabled={connectBusy}>
                  {connectBusy && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
                  Connect GitHub
                </Button>
              </div>
            </form>
          ) : flow.status === "pending" ? (
            <div className="flex flex-col gap-4">
              <p className="text-sm">On github.com, open the link and enter this code:</p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="select-all rounded-md border border-border bg-surface px-3 py-2 font-mono text-lg tracking-widest">
                  {flow.userCode}
                </code>
                <Button type="button" variant="secondary" size="sm" onClick={copyCode}>
                  {copied ? <Check aria-hidden="true" className="size-3.5" /> : <Copy aria-hidden="true" className="size-3.5" />}
                  {copied ? "Copied" : "Copy code"}
                </Button>
              </div>
              <div className="flex flex-col gap-1 text-sm">
                <a href={flow.verificationUri} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground">
                  <ExternalLink aria-hidden="true" className="size-3.5" /> Open github.com/login/device
                </a>
                <a href={flow.installUrl} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 text-muted-foreground underline underline-offset-2 hover:text-foreground">
                  <ExternalLink aria-hidden="true" className="size-3.5" /> Install the app on these repositories
                </a>
              </div>
              <p role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-muted-foreground">
                <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
                Waiting for approval. This code expires at {new Date(flow.expiresAt).toLocaleTimeString()}.
              </p>
              {connectError && <p role="alert" tabIndex={-1} className="text-sm text-danger">{connectError}</p>}
              <div className="flex justify-end">
                <Button type="button" variant="secondary" onClick={closeConnect}>Cancel</Button>
              </div>
            </div>
          ) : flow.status === "connected" ? (
            <div className="flex flex-col gap-4">
              <p role="status" className="text-sm text-success">
                GitHub connected. This agent can now clone private repositories, push branches and open pull requests where the app is installed.
              </p>
              <p className="text-xs text-muted-foreground">
                Disconnecting deletes the saved token here. To revoke it at GitHub too, use{" "}
                <a href="https://github.com/settings/apps/authorizations" target="_blank" rel="noreferrer"
                  className="underline underline-offset-2 hover:text-foreground">your GitHub App authorizations</a>.
              </p>
              <div className="flex justify-end">
                <Button type="button" onClick={closeConnect}>Done</Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <p role="alert" className="text-sm text-danger">
                {flow.status === "denied" ? "The sign-in was denied on GitHub."
                  : flow.status === "expired" || flow.error === "expired_token" ? "The code expired before it was approved."
                    : "GitHub could not complete the sign-in."}
              </p>
              <p className="text-xs text-muted-foreground">Start again and enter the new code on github.com.</p>
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="secondary" onClick={closeConnect}>Close</Button>
                <Button type="button" onClick={() => { setFlow(null); setConnectError(null); setCopied(false); }}>Try again</Button>
              </div>
            </div>
          )}
        </ModalDialog>
      )}

      {removing && (
        <ModalDialog title={`Remove ${removing.label}?`}
          description={`The token for ${agents.find((agent) => agent.id === removing.agentId)?.name ?? "this agent"} is deleted and the proxy stops injecting it.`}
          onClose={() => setRemoving(null)}>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setRemoving(null)} disabled={busy}>Keep it</Button>
            <Button type="button" variant="destructive" onClick={removeConnection} disabled={busy}>
              {busy && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
              Remove connection
            </Button>
          </div>
        </ModalDialog>
      )}
    </div>
  );
}
